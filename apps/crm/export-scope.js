/*
 * export-scope.js - persisted CRM export policy and the dialog that edits one export.
 *
 * Kept apart from export.js so report generation reads a frozen scope and workspace snapshot;
 * this slice owns Chrome preferences and transient dialog state, not report construction.
 */
// ---------- export scope ----------
// Coarse on purpose: sections, never single modules. A per-module allow-list would be a
// permission system, and a permission system that is not enforced anywhere is theatre.
const SCOPE_KEYS = ['functions', 'code', 'modules', 'layouts', 'relations', 'workflows', 'schedules', 'actions', 'addresses', 'connections', 'failures', 'health'];
// `addresses` is off in both, and that is the one default here that is a decision rather than a
// convenience: an export is a file you hand to somebody, and an address is the one thing in this
// mirror that belongs to a person rather than to a configuration. It is one tick away, and the
// report says how many it withheld so nobody reads a blank as an absence.
// `failures` was in SCOPE_KEYS and in neither preset, so the dialog drew its box and the default
// export left the chapter out - and pressing «Everything» *unticked* a box the reader had ticked,
// because the preset is assigned whole. A key in the list and not in the presets is a control that
// disagrees with itself. Found by a review; `tests/panel.test.mjs` now holds the three in step.
const SCOPE_FULL = { functions: true, code: true, modules: true, layouts: true, relations: true, workflows: true, schedules: true, actions: true, addresses: false, connections: true, failures: true, health: true };
const SCOPE_SAFE = { functions: true, code: false, modules: true, layouts: true, relations: true, workflows: false, schedules: false, actions: true, addresses: false, connections: true, failures: true, health: false };
// Which build wrote a stored preference. Declared *here*, above the default that stamps itself with
// it: a `const` used before its declaration is a temporal dead zone, and putting the stamp on
// `SCOPE_DEFAULT` while this sat forty lines below made the whole panel throw at load. Caught by the
// case that evaluates every shipped script - which exists because this class has shipped twice.
const SCOPE_SV = 2;
// **The sensitive section starts unticked, and that is a promise being kept rather than a taste.**
// The site, the README and §4.3 of the privacy policy all say the same thing - «the sensitive part is
// opt-in and flagged when selected» - and this line said the opposite: the first export a person ever
// made arrived with the whole Deluge source in it unless they noticed and cleared it. Found by an
// assistant reading the repository against the site, which is the check the front page now hands out.
// Everything else stays on: what is being defended is the source code, not the export's usefulness.
// **The stamp travels with the value.** `sv` says which build wrote a stored preference, and only the
// *reader* was writing it: so ticking the source code, exporting, and reopening turned it back off -
// the export wrote a scope with no stamp, and the next load read that as a preference from before the
// default changed and applied the one-shot migration again. Measured, in that order. Every object
// derived from this default now carries the stamp, and the migration still fires on a genuinely old
// value because it reads what was *stored*, not what was merged.
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { code: false, sv: SCOPE_SV });
let expScope = Object.assign({}, SCOPE_DEFAULT);
// What the dialog is editing right now, and which of its boxes were cleared *for* the user because
// the data behind them is behind. Kept apart from expScope for one reason: the export dialog saves
// what you leave it with, so mutating the defaults to warn about staleness rewrote them - one
// export and the settings had silently lost Functions and Workflows. A transient warning must never
// become a stored preference. Same lost-update shape as two copies of the settings page.
let dlgScope = Object.assign({}, SCOPE_DEFAULT);
let dlgAutoCleared = new Set();
// **A preference saved before the default was fixed is cleared once, and only once.** The dialog used
// to open with the source ticked, so «code: true» in somebody's stored scope is at least as likely to
// be the old default as a decision - and the promise the site, the README and the privacy policy all
// make is that including it is a decision. So a scope with no `sv` has the sensitive section turned
// off, is written back stamped, and is never touched again: whatever the user chooses from then on
// stands, including turning it straight back on.
//
// Migration that deletes itself, as this repository asks: when nobody can still be carrying an
// unstamped scope, the three lines go and nothing else has to change.
async function loadScope() {
  try {
    const st = await chrome.storage.local.get('exportScope');
    if (!st || !st.exportScope) return;
    const saved = st.exportScope;
    if (saved.sv !== SCOPE_SV) {
      saved.code = false;
      saved.sv = SCOPE_SV;
      await chrome.storage.local.set({ exportScope: saved });
    }
    expScope = Object.assign({}, SCOPE_DEFAULT, saved);
  } catch (_) {}
}
// The tab preference, and the access verdicts recorded for the workspace that is open. Two sources
// because they are two different kinds of fact: what you chose (per install) and what Zoho allows
// (per org). Reading either must never throw the panel - a missing or malformed value just means
// "show everything", which is the state a first run is in anyway.
async function loadZohoDc() {
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) zohoDc = r.zohoDc; } catch (_) {}
}
async function loadTabPrefs() {
  try {
    const st = await chrome.storage.local.get('tabPrefs');
    const p = st && st.tabPrefs;
    if (p && Array.isArray(p.order) && Array.isArray(p.hidden)) {
      tabPrefs = {
        order: p.order.filter((id) => TAB[id]),
        hidden: p.hidden.filter((id) => TAB[id]),
        // Absent in preferences saved before this existed: those said nothing about pulling, so the
        // honest reading is "pull everything", not "skip whatever happens to be hidden today".
        nopull: (Array.isArray(p.nopull) ? p.nopull : []).filter((id) => TAB[id]),
        recheck: (Array.isArray(p.recheck) ? p.recheck : []).filter((id) => TAB[id]),
      };
    }
  } catch (_) {}
}
// Built locally and published in one go, because these two are read by every tab: emptying them
// before the first await meant an overtaken activation blanked the verdicts of the workspace that
// had already arrived, and then filled them in from the one being left.
async function loadAccess(op = beginWorkspaceOp()) {
  let access = {}, last = null;
  try {
    const cfg = await opReadCfg(op);
    if (cfg && cfg.access && typeof cfg.access === 'object') access = cfg.access;
    if (cfg && typeof cfg.lastPull === 'string') last = cfg.lastPull;
  } catch (_) {}
  if (!op.current()) return false;
  tabAccess = access; wsLastPull = last;
  publishAccess();
  return true;
}
// The settings page cannot read the workspace's `.zoost.json` - it has no folder handle and no
// business acquiring one - but it has to be able to say *why* a tab is off, or "hidden" becomes the
// silent state this whole change exists to avoid. So the panel publishes a copy for display.
//
// `.zoost.json` stays the authority: this is never read back into a decision, only into a sentence.
// It carries the workspace's name so the settings page can say which org the verdicts belong to,
// rather than implying they are universal.
function publishAccess() {
  // A copy for the settings page to read; the authority is `.zoost.json` in the workspace, and the
  // page re-reads on change. So a refused write leaves that page showing what it last saw, which is
  // the state it draws whenever it has not been told - not a wrong claim, an old one. Best-effort,
  // and declared: the `try` around this caught nothing, the call not being awaited.
  const w = (wsList || []).find((x) => x.id === activeWsId);
  void chrome.storage.local.set({ tabAccessView: { ws: (w && w.name) || null, access: tabAccess } })
    .catch(() => {});
}

// A bridge reply is a plain object, so rebuilding an Error from it drops `forbidden` unless it is
// carried across explicitly. Same boundary, same trap, third place it could have been lost: the
// content script raises it, the message channel flattens it, and this is where it becomes an Error
// again. Every `if (!r?.ok) throw …` in the pulls goes through here.
function bridgeError(r, fallback) {
  // **No answer at all is its own fact, and it has a sentence.** `chrome.tabs.sendMessage` resolves
  // `undefined` when nothing is listening - a reloaded tab, an extension that has just updated, a
  // frame the bridge never reached - and every caller passed its own internal word as the fallback,
  // so the reader was shown «Error: Error: unknown», «list failed», «pull failed». Four states, no
  // meaning, and `MSG.staleBridge` - which says the true thing and names the remedy - was reached
  // from one place. The twin has answered this with one sentence since it existed.
  return bridgeResponseError(r, fallback, MSG.staleBridge);
}

// Record what Zoho answered for one area, in the workspace's own config. Per workspace, because a
// role is a property of an org: the same person can be an administrator in one and read-only in
// another, and a verdict carried between them would be a guess.
//
// The date is stored with it and shown, because "forbidden" is not a permanent truth - roles change,
// and a verdict from three months ago is a record of what was asked, not a fact about today. That is
// also why nothing here ever hides an area *without* an answer: no measurement means visible.
/** @param {boolean} stored - did this run actually put the area's data on disk?
 *
 *  **«Asked» and «read» are two facts, and one call was writing both.** A list Zoho returns capped
 *  is an answer about access - which is why the three pulls that bail on one record a verdict - and
 *  it is *not* data: nothing is written to the mirror on that path, deliberately. Stamping
 *  `pulledAt` there made a workspace last pulled in May report every one of those areas as read
 *  today, so the staleness note went quiet, the export stopped un-ticking them, and the report's own
 *  header printed «Workflows as of 4 September» over a file from the first of May. A report that
 *  says a third of itself was read today when it was not is the half-truth `freshnessLine` exists to
 *  prevent, and it was thirty minutes old. Found by a reader with no memory of writing it.
 */
async function noteAccess(area, err, op, stored = !err) {
  // An **area**, not a tab. The two are nearly the same list and not quite: `failures` is pulled,
  // can be refused, and has no tab of its own - a failure is a property of a function, so it shows
  // in the function's detail and in the health view. This guard read `TAB[area]`, so every
  // `noteAccess('failures', ...)` returned before doing anything: the runtime chapter never
  // recorded when it was last read, and a role that had lost access to it was indistinguishable
  // from an org where nothing had failed. Two correct halves - a guard that refuses what it does
  // not know, and a caller reporting its own area - composing into a silent bail.
  if (!TAB[area] && !AREA_SCOPE[area]) return;
  // Written after a pull, which means after every await it made: without the op this records one
  // org's refusal in another org's `.zoost.json`, and the verdict is what later pulls skip on.
  if (op && !op.current()) return;
  const state = !err ? 'ok' : err.forbidden ? 'forbidden' : 'failed';
  const before = accessOf(area);
  const prev = tabAccess[area] || {};
  const nextAccess = Object.assign({}, tabAccess, { [area]: {
    state, status: (err && err.status) || 0,
    // The refusal's own words, where it had them. Without this the status line said the measured
    // thing and Settings went on asserting «not granted to your Zoho role» about a 400 - the same
    // invention, on the surface nobody re-read. Grep the claim, not the paragraph.
    note: (err && err.note) || null,
    at: new Date().toISOString(),
    // `at` is when we asked; `pulledAt` is when we last actually got the data. They diverge the
    // moment an area stops being pulled, and that gap is the whole point: it is what makes a stale
    // section detectable instead of silently old.
    pulledAt: stored ? new Date().toISOString() : (prev.pulledAt || null),
    // **«It did not work» and «it worked and came up short» were the same record.** Three pulls
    // report a gap - a module Zoho would not describe, a stale file that would not delete -
    // with a pseudo-error, so a workspace whose 1,200 functions are all on disk was marked
    // `failed` exactly like one whose pull was refused. Settings then either told the first that
    // its pull had not succeeded, or - branching on the words instead - told the second nothing
    // at all, because only one refusal in the whole extension carries words. The two events are
    // different in one respect that nothing was writing down: whether the mirror was written.
    stored: !!stored,
  } });
  // Disk is the authority. Publishing the optimistic value first made a failed config write hide a
  // tab until the next reopen; publishing after an overtaken write put the old org's verdict beside
  // the new workspace. Keep the old in-memory answer unless the same operation commits the new one.
  try { await patchCfg({ access: nextAccess }, op); }
  catch (e) {
    if (op && !op.current()) return false;
    setStatus(`Could not record the ${tabLabel(area)} access state: ${(e && e.message) || e}`, 'bad');
    return false;
  }
  if (op && !op.current()) return false;
  tabAccess = nextAccess;
  publishAccess();
  if (before !== state && (before === 'forbidden' || state === 'forbidden')) renderTabs();   // the set of tabs just changed
  return true;
}

// What the user reads when an area is refused. Never the status line on its own: "403 on
// /crm/v2/settings/functions" reads as Zoost being broken, which is both alarming and wrong.
function pullFailMessage(area, e) {
  if (e && e.forbidden) {
    // **Only an area with a tab is told about its tab.** `failures` has none - a failure is a
    // property of a function, so it shows in the function's detail and in the health view - and
    // Settings draws its rows from the tab registry, so there is no row, no «why» and no «ask
    // again» box for it either. Routing that pull through `bridgeError` made this branch reachable
    // for it for the first time, and it promised all three: the wrong missing thing, in the
    // sentence a reader acts on. `areaLabel` too, or the name is the bare lowercase id.
    //
    // 401 and 403 say «no permission» themselves, so the role sentence is theirs. A refusal that
    // arrived in other words brings its own, rather than being told a cause nobody measured.
    return `${areaLabel(area)}: ${e.note || 'your Zoho role does not grant access'}`
      + `${e.status ? ` (Zoho answered ${e.status})` : ''}. Nothing was pulled for it`
      + (TAB[area] ? ', and the tab is hidden - Settings says why, and lets you check again.' : '.');
  }
  // **A failure that knows what to say says it.** Not every refusal arrives as a 401 or a 403 - the
  // deluge runtime answers INVALID_CSRF_TOKEN to a user it will not serve - and for a while that was
  // promoted to a role verdict, which hid the tab on an inference Zoho never made. It is a failure
  // like any other now; what it keeps is its own sentence, so the reader gets the calm true thing
  // rather than «400 on /deluge/api/ui/v1/…» followed by the page's cookie names.
  if (e && e.note) return `${tabLabel(area)}: ${e.note}${e.status ? ` (Zoho answered ${e.status})` : ''}.`;
  // Through `friendlyError` for the same reason as the Analytics twin: a pull is minutes of
  // network work and Chrome lets the folder permission lapse while it runs, so the last stage
  // throws `NotAllowedError: The request is not allowed by the user agent…` and this printed it
  // whole - a platform sentence naming neither the folder nor the button that fixes it.
  return `${tabLabel(area)} pull error: ${friendlyError(e)}`;
}

// The two halves of a failed pull, always taken together: record what Zoho answered for the area,
// then say it. Recording without saying leaves the user with a tab that vanished and no reason;
// saying without recording loses the verdict the next pull skips on. Six sites did both by hand.
async function notePullFailure(area, e, op) {
  // An overtaken pull ends in here, because the writer refused it. There is nothing true to say: the
  // verdict belongs to the folder we left and cannot be written to it, and the sentence would name
  // an area of an org the reader is no longer looking at. It stops, quietly.
  if (op && !op.current()) return;
  // Bridge replies already carry a structured error.  Filesystem, configuration and controller
  // failures do not cross that boundary, though, and used to arrive here as ad-hoc strings.  Give
  // those failures the same machine-readable classification while preserving the original message
  // (the user-facing detail and the report must not collapse to a generic error-code label).
  if (typeof classifyZoostError === 'function' && (!e || !e.code || !e.area)) {
    const source = e instanceof Error ? e : new Error(String(e || 'unknown'));
    const structured = classifyZoostError(source, area);
    if (e && typeof e === 'object') Object.assign(e, structured);
    else e = structured;
  }
  // What a report opened from here will be about. Handled failures never reached `lastThrown`,
  // and this is the only place they can.
  noteThrown(e);
  await noteAccess(area, e, op);
  setStatus(pullFailMessage(area, e), 'bad');
  // A role refusal is not a platform change and no release will fix it, so the pointer would be
  // sending the reader somewhere that cannot help. Everything else is «Zoho did not answer the way
  // this expects», which is exactly the case /emergency exists for.
  //
  // **`forbidden` is not the whole of «no release fixes this».** A refusal Zoho worded some other way
  // carries its own sentence, and the panel had just told the reader «this Zoho user may not have
  // access to it» and then offered «A fix may already be released» underneath it - two answers to
  // one question, and the reader's own objection: «non è un problema applicativo». A failure this
  // panel can explain in Zoho's terms is not one a release changes; what stays pointed at /emergency
  // is what nothing here can account for, which is the case that button was written for.
  // The link only where a release could be the answer; the report button wherever there is something
  // to report, which is every failure. A role refusal keeps neither: Zoho stated it, no release
  // changes it, and there is nothing here for anybody to look at.
  showEmergency(!(e && (e.forbidden || e.note)), !(e && e.forbidden));
}

// After a full pull: one line naming the areas that were refused. Said once, plainly, rather than
// five separate alarms - and it has to be said, because the tabs have just silently gone away.
function forbiddenNote() {
  const off = TABS.map((t) => t.id).filter(isForbidden);
  if (!off.length) return '';
  return ` · ${off.length} area${off.length > 1 ? 's' : ''} refused by Zoho (${off.map(tabLabel).join(', ')}) - hidden`;
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!dlgScope[k]; });
  const e = $('sc_code'); if (e) e.disabled = !dlgScope.functions;
  const l = $('sc_layouts'); if (l) l.disabled = !dlgScope.modules;
  // Relations has the identical dependency and was left live: `scopeFromUI` forces it off whenever
  // Modules is, then repaints, so the tick bounced straight back and the dialog said nothing. A
  // control that refuses in silence is worse than one that is visibly unavailable.
  const rl = $('sc_relations'); if (rl) rl.disabled = !dlgScope.modules;
  $('scwarn').textContent = dlgScope.code ? '\u26a0 includes full source code' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) { if (!!e.checked !== !!dlgScope[k]) dlgAutoCleared.delete(k); dlgScope[k] = !!e.checked; } });
  if (!dlgScope.functions) dlgScope.code = false;
  if (!dlgScope.modules) { dlgScope.layouts = false; dlgScope.relations = false; }
  scopeToUI();
}
// Which export sections come from which pulled area. Not a lookup for its own sake: it is what lets
// the dialog say "this box is off because that data is four months old" instead of quietly offering
// a report whose Connections chapter is from February and looks exactly as current as the rest.
const AREA_SCOPE = {
  functions: ['functions', 'code'],
  modules: ['modules', 'layouts', 'relations'],
  workflows: ['workflows'],
  schedules: ['schedules'],
  actions: ['actions', 'addresses'],
  connections: ['connections'],
  failures: ['failures'],
};

// The areas, which is what `AREA_SCOPE` has always been the list of: the tabs, plus the ones with no
// tab of their own. Everything about freshness walks this rather than `TABS`, because an area
// without a tab is still pulled and can still be behind - `failures` was in this table from the
// day it was written and reached by nothing, since all three walks started from the tabs.
const AREA_IDS = Object.keys(AREA_SCOPE);
// The name a reader sees for an area. From the tab where there is one, and from the id itself
// otherwise - derived rather than a second table, so it cannot drift out of step with the first.
const areaLabel = (id) => (TAB[id] ? TAB[id].label : id.charAt(0).toUpperCase() + id.slice(1));

// Sections whose data is behind are cleared when the dialog opens, and why is written next to them.
// Cleared rather than removed: an old chapter is sometimes exactly what you want, so the choice
// stays yours - but it has to be a choice, and the default has to be the safe one. If you tick it
// back on, the report carries that section's own date, so the reader is told too.
//
// This makes the export follow the pull settings without a second set of switches to keep in step.
// Two lists that must agree are two lists that will not.
function scopeStaleNote() {
  const behind = AREA_IDS.filter(areaStale);
  const box = $('scstale');
  if (!box) return;
  if (!behind.length) { box.textContent = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = behind.map((id) =>
    `<div><b>${escHtml(areaLabel(id))}</b> - ${escHtml(areaAsOf(id))}, because ${escHtml(staleReason(id))}. `
    + 'Unticked; tick it to include it anyway and the report will carry that date.</div>').join('');
}
/** What the keyboard can reach while a dialog is up.
 *
 * The scrim is a painted div at z-index 85: it stops the pointer and nothing else. The dialog traps
 * no focus and the background was not inert, so Shift+Tab from an open «What goes into the export»
 * reaches **Export** behind it and Enter asks the same question again - which overwrites the one
 * resolver `askScope` has and abandons the first promise for the life of the panel.
 *
 * `inert` on the two roots rather than a focus trap: it is the platform's own answer, it covers
 * click, focus, Tab and the accessibility tree in one attribute, and it needs no bookkeeping to undo
 * beyond setting it back. The dialogs and the scrim sit outside `#wrap`, so nothing that has to stay
 * reachable is inside what is switched off.
 */
function panelInert(on) {
  // Derived, never named: everything the page is made of except the scrim and the dialogs
  // themselves. The first version listed two ids and **neither existed** - a helper written from
  // memory of a layout, which would have set `inert` on nothing at all and passed every check that
  // only reads the calls. Found by grepping the markup for the names it had invented.
  [...document.body.children].forEach((el) => {
    if (el.id === 'scrim' || el.classList.contains('dlg')) return;
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    // The slot holds one question. Overwriting it left whatever was waiting on the older one waiting
    // for the life of the panel, having shown nothing - it had not reached `op.say` yet, so there was
    // no status line to go stale and nothing at all on screen. Settled as «cancelled», which is what
    // it became.
    if (_scopeResolve) _scopeResolve(null);
    _scopeResolve = resolve;
    dlgScope = Object.assign({}, expScope);
    dlgAutoCleared = new Set();
    AREA_IDS.forEach((id) => { if (areaStale(id)) AREA_SCOPE[id].forEach((k) => { if (dlgScope[k]) { dlgScope[k] = false; dlgAutoCleared.add(k); } }); });
    scopeToUI();
    scopeStaleNote();
    $('scrim').classList.add('on'); panelInert(true); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); panelInert(false); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  if (r) r(ok ? Object.assign({}, dlgScope) : null);
}
function showAbout() {
  $('aboutbody').innerHTML =
    `<div><b>${escHtml(PRODUCT_NAME)}</b> \u00b7 v${escHtml(chrome.runtime.getManifest().version)}</div>`
    + `<div style="color:var(--muted)">Created by ${escHtml(PRODUCT_AUTHOR)} (with the support of Claudio)</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> \u00b7 <a href="${escA(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> \u00b7 <a href="${escA(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> \u00b7 <a href="${escA(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> \u00b7 <a href="${escA(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> \u00b7 <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> \u00b7 <a href="mailto:${escA(CONTACT_EMAIL)}">${escHtml(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div>${SPONSOR_URL ? `<a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}${SPONSOR_URL && KOFI_URL ? ' \u00b7 ' : ''}${KOFI_URL ? `<a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">\u2615 Ko-fi</a>` : ''}</div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${escHtml(PRODUCT_LICENSE)}</a> \u00b7 \u00a9 2026 ${escHtml(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${escHtml(LEGAL_DISCLAIMER)}</div>`
    // **«Sends nothing anywhere» stopped being true the day the assistant shipped**, and this dialog
    // went on saying it while the store copy, the site and the twin panel were all corrected. The
    // twin's wording is the one that survived that argument, so this is the twin's wording with this
    // product's own nouns - and both now name the report page, which neither did.
    + `<h4>Your data</h4><div class="legal">The mirror stays between your browser, your Zoho session and the local folder you picked. `
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the org it needs - function names and source code, module and field names including the values inside a picklist, workflow and schedule names, what an automation action does - the field it writes and the value, the fields a task fills in, the email template it sends, a webhook's method and host - the name Zoho records as having last changed a function or a connection and when, connection names with their connectors and scopes, and what Zoho reports about failed runs - are sent directly from your browser to the provider you configured, and to no one else. `
    + `Records are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine, except a problem report you write, read in full and send yourself. `
    + `Exports are written to your workspace folder - what happens to them afterwards is up to you.</div>`;
  $('scrim').classList.add('on'); panelInert(true); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); panelInert(false); $('aboutdlg').classList.remove('on'); }
