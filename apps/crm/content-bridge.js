/*
 * content-bridge.js - ISOLATED world on the Zoho page.
 * Wrapped in a guard so it is safe to (re)inject via chrome.scripting.
 */
(function () {
  // A version, not a boolean, for the reason `hook.js` already records: «a page already running the
  // previous build carries the previous number, and an equal number means nothing to do - so leaving
  // it alone leaves the old one in place in every open tab. That is what it did once, and it cost an
  // evening of fixes that could not take effect.» The hook learnt it; this half, which is the one
  // that actually fetches, kept the boolean.
  //
  // What it costs is nothing, and what it buys is the documented recovery: when the extension is
  // updated under an open tab the old script is orphaned - its `chrome.runtime` is gone, which is
  // what the notice below reports - and the panel's answer is to re-inject. Against a boolean that
  // re-injection returned at the first line and left the dead copy in place until the reader
  // reloaded the tab. Two listeners cannot result: an orphaned context cannot answer, and a live one
  // of a different build cannot exist without an update having orphaned it.
  // **Derived from the build, not a counter somebody has to remember.** It was `1` from the commit
  // that introduced it, and this file changed three times after that - the frame identity gate, the
  // shared reply, the queued answer - so an open Zoho document kept answering with the old bridge and
  // the re-injection that was supposed to replace it returned at this line. A guard that cannot tell
  // two builds apart is the boolean it was written to stop being.
  const BRIDGE_V = chrome.runtime.getManifest().version;
  if (window.__zoostBridge === BRIDGE_V) { return; }
  window.__zoostBridge = BRIDGE_V;

  const PAGE = 50;
  // One ceiling for every page loop in this file. It used to be `page > 20` written twice and absent
  // twice: the two loops without it could walk for ever on an endpoint that never says «no more»,
  // and - worse for a mirror - the two that had it were the only ones that could *say* they had
  // stopped early. A partial list must never be shaped like a complete one, so every loop now
  // counts against this and every result carries `capped`.
  // 20 pages of 50 was a thousand functions, and a thousand is a real org: past it every list came
  // back `capped`, and since a partial list may not prune or replace the index, create, delete and
  // pull all stopped working entirely - with a message telling the reader to try again, which could
  // only produce the same answer. The ceiling exists to stop a loop that never ends, not to decide how
  // large an org may be, so it is set where it does that job: 400 pages is 20,000 functions, four
  // times the largest org this has been measured against, and a page that returns fewer than it was
  // asked for still ends the walk on the first one.
  // Per endpoint, because the walks do not ask for the same page size: functions read 50 at a time
  // and workflows 200, so one number meant «1,000 functions» and «80,000 workflows» - a ceiling in
  // the way of a real org on one side and no ceiling at all on the other. Each is set where it stops
  // a walk that never ends, well past where the platform's own limits sit.
  const MAX_PAGES = 400;          // functions: 50 a page, so 20,000
  const MAX_PAGES_WIDE = 40;      // workflows and schedules: 200 a page, so 8,000
  // Its own, for the reason written above: this walk reads two strings per function, not a source.
  // 100 is what Zoho's own page asks for; 8,000 functions before the bound is a ceiling nothing real
  // reaches, and a walk that hits it says so rather than returning a map with holes in it.
  const UI_ID_PAGE = 100;
  // How many executions one function's detail asks for. Its own number: this is a page of rows a
  // person reads, not a walk that has to be complete.
  const RUNTIME_LOGS = 40;
  // The windows the logs endpoint is asked for, and the only ones: a period is a token in a URL, and
  // this project does not invent another product's vocabulary - `language=nodejs` was guessed once
  // and shipped a pull that found nothing. These two were measured on a real org; if Zoho's own menu
  // offers more, one capture of it adds them here and nowhere else.
  const RUNTIME_WINDOWS = ['past_24_hours', 'today', 'yesterday', 'last_month', 'specific_date', 'custom'];
  // The two that carry a range, and the shape it has to be in: a local datetime with the offset
  // spelled out, which is what their own page sends. Anything else is not sent at all - these
  // values arrive across a boundary and end up in a URL.
  const RUNTIME_RANGED = ['specific_date', 'custom'];
  const RUNTIME_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  const BASE = location.origin;
  // One cookie by name. `split('=')[1]` was what this did, and it truncates at the first `=` inside
  // the *value* - which is padding on anything base64, and a silent one: the request goes out with
  // two thirds of a token and comes back as an unexplained 400 or 401, indistinguishable from a
  // session that has expired. The value is everything after the first `=`, which is what a cookie
  // is. A declaration rather than an arrow so `tests/slice.mjs` can lift it, and byte-identical in
  // both bridges.
  function cookie(n) {
    const c = document.cookie.split('; ').find((x) => x.startsWith(n + '='));
    // Everything after the first `=`, which is what a cookie value is.
    //
    // **This line was blamed for a live failure and it was not the cause.** The connections pull
    // began answering 400 INVALID_CSRF_TOKEN; this reading had changed five days earlier, from «the
    // part between the first `=` and the second», and it was the only line in the whole request path
    // that had moved in twenty days - so it was restored on that reasoning. The measurement that
    // settled it came from the org itself: the token is 128 characters and carries no `=` at all, so
    // the two readings return the identical value and neither can have broken anything.
    //
    // Restored again, and the episode is what the line is worth keeping for: **the only change in a
    // window is not the cause, it is the first suspect**, and the difference between the two is a
    // measurement. The error below reports the token's shape now, which is how this one was closed in
    // a single pull instead of another day.
    return c ? c.slice(n.length + 1) : undefined;
  }

  function instanceName() {
    const p = location.pathname.split('/').filter(Boolean);   // e.g. ['crm','yourinstance','tab','Contacts']
    const i = p.indexOf('crm');
    const cand = i >= 0 ? p[i + 1] : (p[0] === 'crm' ? p[1] : null);
    return (cand && !/^v\d/.test(cand) && cand !== 'org') ? cand : null;   // skip API version / org-prefixed forms
  }
  // Both of these read the id out of the page's markup, and both were called per request - `orgId()`
  // from the header builder, so a pull of a few thousand functions serialised the whole CRM DOM a few
  // thousand times. What is remembered is a *successful* read only: a page that has not rendered the
  // field yet must be asked again, and a value that was found cannot change without a navigation,
  // which replaces the document this script is attached to. Switching org in Zoho is such a
  // navigation; the panel compares the org against the binding on every pull regardless.
  let _org = null, _zuid = null, _pageCsrf = null, _memoAt = null;
  // The URL the memo belongs to. The paragraph above rests on «a value that was found cannot change
  // without a navigation, which replaces the document this script is attached to» - and that is a
  // claim about somebody else's single-page application, which nothing here can establish.
  // `history.pushState` changes the path without replacing anything, and the guard that is supposed
  // to notice - `expectedMatches` - compares the panel's expectation against `context()`, which
  // reads *this memo*: a stale value is compared with itself and agrees.
  //
  // One line instead of an assumption: the memo belongs to the URL it was read at, and a different
  // one re-reads. The saving it exists for is intact - a pull of a few thousand functions serialised
  // the whole CRM DOM a few thousand times - because the URL does not change during a pull.
  function memoValid() {
    if (_memoAt === location.href) return true;
    // `_pageCsrf` belongs here for the same reason the other two do, and the check written for
    // them caught it the day it was added: it is read out of one document's own response, and a
    // pushState inside a suite shell changes the document under it. A token remembered across
    // that is the same defect as an org id remembered across it.
    _memoAt = location.href; _org = null; _zuid = null; _pageCsrf = null;
    return false;
  }
  function orgId() {
    memoValid();
    if (_org) return _org;
    // The CRM org id is the zgid / crmZgid. Do NOT fall back to a generic "orgId":
    // on some pages that is an embedded ASAP/help-portal id (e.g. ASAP_ORGID), not the CRM org.
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/(?:crmZgid|["']?zgid["']?)["'\s]*[,:=]["'\s]*(\d{9,})/);
      if (m) return (_org = m[1]);
    } catch (_) {}
    return null;
  }
  // The Zoho user id (zuid) is on every CRM page - a #dreZuId field (deluge runtime) and a `zuid`
  // JS global. The connections catalogue endpoint needs it. Scraped like orgId (same fragility).
  function zuid() {
    memoValid();
    if (_zuid) return _zuid;
    try { const el = document.getElementById('dreZuId'); const v = el && String(el.value || el.textContent || '').trim(); if (v && /^\d{6,}$/.test(v)) return (_zuid = v); } catch (_) {}
    try { const m = document.documentElement.innerHTML.match(/\bzuid\s*["'\s]*[:=]\s*["']?(\d{9,})/i); if (m) return (_zuid = m[1]); } catch (_) {}
    return null;
  }
  const context = () => ({ ok: true, origin: BASE, org: orgId(), instance: instanceName(), zuid: zuid() });

  // The /crm/... APIs want the CSRF as `crmcsrfparam=<token>`; the /deluge/ (DRE) APIs want `drepn=`.
  //
  // "Same value, different prefix" was wrong, and wrong in the way that hides itself: the two are
  // *usually* equal, so reading CT_CSRF_TOKEN for both worked right up until the day they diverged
  // and the connections pull started answering 400 INVALID_CSRF_TOKEN. Hooking setRequestHeader on
  // the page and comparing what Zoho's own UI sends against the cookie jar settled it - the deluge
  // runtime's token is the **`drecn`** cookie, and in the capture where it had rotated it was the
  // only cookie holding the value Zoho accepted.
  //
  // Note the shape of the trap, because it is the same one as the Analytics bridge from the other
  // side: the header prefix is `drepn`, the cookie is `drecn`. One letter apart, and neither is
  // derivable from the other. Find the source; never infer it from the prefix.
  const CSRF_COOKIES = {
    drepn: ['drecn'],                                          // deluge runtime
    crmcsrfparam: ['CT_CSRF_TOKEN', 'crmcsr', 'CSRF_TOKEN'],   // CRM APIs
  };
  // **Where the last token came from.** A 400 INVALID_CSRF_TOKEN is the same three words whether the
  // deluge cookie was missing, stale, or present and rejected - and those are three different
  // problems with three different answers. The fallback below is a *guess by design*: it sends the
  // CRM family's token to the deluge runtime because before the two diverged that was usually right.
  // When a request fails, which of the two it actually sent is the first thing anybody needs, and
  // until now nothing recorded it. Written where the choice is made, read where the failure is
  // reported - never inferred from the prefix, which is the trap this file already carries a note
  // about (`drepn` the header, `drecn` the cookie, one letter apart and neither derivable).
  // And its *shape*, which is what decides the one open question about this failure. `cookie()`
  // changed on 20 August from `split('=')[1]` - the part between the first and the second `=` - to
  // everything after the first, and those two differ for exactly one kind of value: one carrying an
  // `=`, which is base64 padding. That commit called the change latent, on the ground that «the
  // values captured on this account are hex». A length and a yes/no about one character say whether
  // that ground held, and neither is the token.
  let lastCsrfFrom = null;
  let lastCsrfShape = '';
  function csrfToken(csrfPrefix) {
    const names = CSRF_COOKIES[csrfPrefix || 'crmcsrfparam'] || CSRF_COOKIES.crmcsrfparam;
    const shape = (v) => `${v.length} chars, ${v.includes('=') ? 'contains' : 'no'} \u0027=\u0027`;
    // The page's own token first, once something has gone and read it: it is what Zoho sends, to both
    // families, and it is not in the cookie jar. See `pageCsrfToken`.
    memoValid();
    if (_pageCsrf) { lastCsrfFrom = 'the page (ConstantsInitial.do)'; lastCsrfShape = shape(_pageCsrf); return _pageCsrf; }
    for (const n of names) { const v = cookie(n); if (v) { lastCsrfFrom = n; lastCsrfShape = shape(v); return v; } }
    // Fall back to the other family rather than sending nothing: an empty token is a guaranteed 400,
    // and before this split the shared value was right often enough to be worth trying.
    for (const n of CSRF_COOKIES.crmcsrfparam.concat(CSRF_COOKIES.drepn)) {
      const v = cookie(n);
      if (v) { lastCsrfFrom = n + ' (fallback - not this family\u0027s own cookie)'; lastCsrfShape = shape(v); return v; }
    }
    try {
      const el = document.getElementById('token');
      if (el && el.value) { lastCsrfFrom = '#token in the page'; lastCsrfShape = shape(el.value); return el.value; }
    } catch (_) {}
    // **Both of these left the previous request's shape in place**, so the message read «the token
    // was read from nowhere - no CSRF cookie was readable (128 chars, no '=')»: a token from nowhere,
    // a hundred and twenty-eight characters long. `lastCsrfShape || 'no value'` cannot catch that,
    // because the string is not empty - it is another moment's. The shape was added because three
    // words fitted every explanation, and a shape that is a memory of a different request is the same
    // failure one field along.
    lastCsrfFrom = 'nowhere - no CSRF cookie was readable';
    lastCsrfShape = 'no token was sent';
    return '';
  }
  function headers(csrfPrefix) {
    const h = { 'X-ZCSRF-TOKEN': (csrfPrefix || 'crmcsrfparam') + '=' + csrfToken(csrfPrefix), 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
    const org = orgId(); if (org) h['X-CRM-ORG'] = org;
    return h;
  }
  // **The one fact that tells a broken token from a refused endpoint, and it is free.**
  // «400 INVALID_CSRF_TOKEN» is three words that fit every explanation, and the diagnostic written
  // for them dumps the cookie jar at the reader - alarming, and wrong whenever the token is fine.
  // A user with a reduced role produced 321 requests carrying **one** 128-character token: the CRM
  // API answered 200 to 179 of them and the deluge runtime refused two with those three words. So
  // the token was never the problem, and nothing had to be guessed to know it - only remembered.
  //
  // Recorded from `/crm/` answers only, so the sentence it licences («a token Zoho is accepting for
  // every other read») says exactly what was observed. A value, not a boolean: a token Zoho rotates
  // mid-session must not inherit the last one's good name.
  let _tokenAccepted = '';
  // `warmDeluge` is reached from `api()` and now calls it back. One flag, so a primer that is itself
  // refused cannot start another.
  let _warming = false;
  const tokenOf = (h) => String(h['X-ZCSRF-TOKEN'] || '').split('=').slice(1).join('=');
  function noteTokenAccepted(path, h, res) {
    if (!res || !(res.ok || res.status === 204)) return;
    if (String(path).startsWith('/deluge/')) return;
    const t = tokenOf(h); if (t) _tokenAccepted = t;
  }
  // A refused request is a different fact from a failed one, and the panel has to be able to tell
  // them apart: "your Zoho role does not cover this" is something the user can act on, while
  // "500 on /crm/v2/…" is not. Zoho answers 401 when the session is not entitled and 403 when the
  // profile is not - both mean *asked and refused*, neither means Zoost is broken.
  //
  // Not verified: whether Zoho ever signals a permission refusal as 200 with an error body. If it
  // does, that case will read as a normal failure here rather than being mislabelled - which is the
  // right way round for a guess we have not tested.
  function apiError(status, path, detail, code) {
    const e = new Error(status + ' on ' + path + (detail ? ' - ' + detail : '') + (code && code !== detail ? ' [' + code + ']' : ''));
    e.status = status;
    e.forbidden = status === 401 || status === 403;
    e.detail = detail || null;
    // Zoho's machine-readable reason, kept apart from the sentence. `INVALID_MODULE` is the one a
    // caller can act on; "operation cannot be performed for hidden module" is the one to show a
    // person. Nothing branches on either here - both are carried, and the caller decides.
    e.code = code || null;
    return e;
  }
  // Zoho explains itself in the body and we were throwing it away. A connections pull failing with
  // `{"errorMessage":"INVALID_CSRF_TOKEN"}` reached the user as the bare string "400 on
  // /deluge/api/…", which names the symptom and hides the one word that says what to do. Read at
  // most a short body, and only to quote it - nothing here branches on its contents.
  async function errorDetail(res) {
    try {
      const t = (await res.text()).slice(0, 400);
      const m = t.match(/"(?:errorMessage|message|error)"\s*:\s*"([^"]{1,120})"/);
      // `code` is read separately rather than added to the alternation above: it appears *first* in
      // a CRM error body, so folding it in would have made the regex return INVALID_MODULE and lose
      // the sentence - and `api()` compares this value against INVALID_CSRF_TOKEN.
      const c = t.match(/"code"\s*:\s*"([A-Z0-9_]{1,60})"/);
      return { message: m ? m[1] : null, code: c ? c[1] : null };
    } catch (_) { return { message: null, code: null }; }
  }
  // Right after a fresh login the deluge runtime rejects the very first `/deluge/` call with
  // 400 INVALID_CSRF_TOKEN, and any `/crm/` call in between makes the next attempt succeed -
  // reproduced deliberately: log out, log in, pull connections (fails), pull schedules, pull
  // connections (works). It is also why "Pull all" never showed this: functions run first.
  //
  // Which of the two explanations is true - `drecn` not yet set/refreshed, or the deluge session not
  // yet initialised server-side - is **not** established. It does not need to be: the remedy is the
  // same under both, and it is the one that was measured rather than reasoned about. So on exactly
  // that error, make one ordinary CRM call and try again, once.
  //
  // This is the "recovering by a known action" exception, not a retry loop: one attempt, only on a
  // specific error string, only for the deluge family, and the primer's own result is ignored -
  // we are after the side effect, and a user whose role refuses that endpoint is no worse off than
  // before. If the second attempt fails the original error is what the user sees.
  /** The CSRF token the page itself uses, read from where the page gets it.
   *
   *  **Measured from Zoho's own successful request**, not reasoned about. A capture of the Connections
   *  screen loading shows `x-zcsrf-token: drepn=<128 chars>`, answered 200, and that value is in no
   *  cookie at all - `drecn` does not exist on this data centre and the comparison says so. It is
   *  byte-for-byte the same value Zoho sends to the `/crm/` endpoints as `crmcsrfparam`: one token,
   *  two prefixes. Its source is the `csrfToken` field of `ConstantsInitial.do`.
   *
   *  What we send is the `CT_CSRF_TOKEN` **cookie**, which is a different value. The CRM API accepts
   *  it, the deluge runtime does not - which is exactly the shape of the report: every area pulls and
   *  connections alone is refused.
   *
   *  Read lazily and once: this is a GET on the reader's own session against the same origin, the
   *  same kind of call the rest of this file makes, and it happens only when a deluge request has
   *  already been refused.
   */
  async function pageCsrfToken() {
    memoValid();
    if (_pageCsrf) return _pageCsrf;
    const inst = instanceName();
    if (!inst) return null;
    try {
      const r = await fetch(BASE + safePath(`/crm/${encodeURIComponent(inst)}/ConstantsInitial.do`),
        { headers: headers(), credentials: 'include' });
      if (!r.ok) return null;
      const m = (await r.text()).match(/"csrfToken"\s*:\s*"([^"]{16,512})"/);
      return m ? (_pageCsrf = m[1]) : null;
    } catch (_) { return null; }
  }

  async function warmDeluge() {
    // Its own result is still not acted on - the side effect is the point, and a role that cannot
    // reach this endpoint is no worse off for having asked. What is returned is whether the primer
    // itself got an answer, so a second refusal can say whether it was ever primed at all. That
    // distinction is the difference between «the token is wrong» and «the session is not there».
    // **The primer stopped being a superstition.** It used to make an ordinary CRM call and hope the
    // deluge runtime would accept the next attempt - a remedy chosen without knowing which of two
    // explanations was true, said so in its own comment, and measured not to work. It now fetches the
    // token the page itself uses; the retry sends that instead of the cookie.
    //
    // **The memo is dropped first, and the answer is whether a token was actually fetched.** Without
    // that this returned `true` on a memo it had not refreshed: the second refusal in one page's life
    // re-sent a byte-identical request and the message said «still refused after a refresh» about a
    // refresh nobody had made - the exact class of false diagnostic this branch exists to end.
    // Measured, both halves.
    //
    // It also matters beyond the retry. `_pageCsrf` outranks every cookie for both families and was
    // cleared only by a change of URL, so a token Zoho rotated while the tab sat still was pinned for
    // the life of that page and *every* area's pull failed, not only the deluge one. Reading the
    // cookie fresh on each request used to make that self-correcting; dropping the memo on a refusal
    // is what puts that back.
    _pageCsrf = null;
    const got = await pageCsrfToken();
    // **The token has to be *seen accepted*, not merely fetched.** Reported from a real org: a pull
    // of the Connections tab alone makes no other request in that page's life, so nothing had ever
    // recorded an acceptance and the refusal that followed fell back to the cookie diagnostic - the
    // alarming one, about a token that was fine. The evidence this needs is one ordinary CRM read
    // carrying the value we are about to send again, so it is taken here rather than hoped for.
    //
    // Through `api()`, so the acceptance is recorded where every other one is; guarded against
    // re-entry, because this is reached *from* `api()` and a primer that itself answered
    // INVALID_CSRF_TOKEN would call it again. Its own outcome is still not acted on: a role that
    // cannot read schedules is no worse off for having asked, and what the next refusal means is
    // decided by whether the token was accepted, which is a different question.
    if (!_warming) {
      _warming = true;
      // Marked as already retried: a primer that is itself refused must not start a recovery of its
      // own, or one deluge failure fans out into a second token fetch and another request. The flag
      // above stops the re-entry; this stops the extra round trip inside it.
      try { await api('/crm/v9/settings/automation/schedules?page=1&per_page=1', 'crmcsrfparam', true); }
      catch (_) { /* what it answers says nothing; that it accepted the token is what is recorded */ }
      finally { _warming = false; }
    }
    // **And the old primer's 200 is not a refresh.** `pageCsrfToken` answers null on four paths - no
    // instance, a refused read, a body with no `csrfToken`, a network throw - and a `true` here was
    // once read as «a token was fetched», so the retry re-sent the same cookie and the reader was
    // told it had been refused after a refresh. What is returned is only whether a token was
    // actually fetched; the primer above runs either way, because its purpose is no longer to hope
    // - it is to see the token accepted, which is what tells the next refusal apart from a fault.
    // There was a second primer here doing the old job by raw `fetch`, and with the one above it
    // fired twice per recovery: one request nobody had asked for, found by counting them.
    return !!got;
  }
  // «Zoho said none» and «Zoho answered something this code does not recognise» are two different
  // facts, and `(resp.workflow_rules || [])` turned the second into the first: a response whose shape
  // changed would have been mirrored as an empty area, in silence, by a tool whose entire purpose is
  // to be a faithful copy. Nobody would see a failure - they would see zero workflows and believe it.
  //
  // 204 is the only absence Zoho actually states, so it is the only one accepted as one. Anything
  // else missing its collection is a shape that has moved, and it stops with a message naming the
  // field. What that costs, said plainly rather than discovered: if some endpoint answers 200 with
  // the field absent for an org that genuinely has none - not observed here, and not testable
  // without such an org - that area now reports an error instead of writing zero. That is the right
  // way round for a mirror, and it is visible and reportable instead of silent.
  const NO_CONTENT = Object.freeze({});
  function list(resp, field, path) {
    if (resp === NO_CONTENT) return [];
    const v = resp && resp[field];
    if (Array.isArray(v)) return v;
    const e = new Error(`${path} answered without a «${field}» list - the response is not the shape `
      + 'this reads, so nothing was written for it. Zoho may have changed the endpoint.');
    e.shape = true;
    e.status = 0;
    throw e;
  }

  /** Refuse a path that is not the one it looks like.
   *
   *  Every path here is built by interpolation, and some of the values come out of the working
   *  folder: `functions/index.json` is read off disk and its `id` goes into
   *  `/crm/v2/settings/functions/${id}`. A workspace folder is text somebody else may have written -
   *  received, shared, synced - and `"id": "../../../v2/users?type=AllUsers&x="` is normalised by the
   *  URL parser into an endpoint nobody chose, fetched with the reader's own session and cookies.
   *
   *  Held here rather than at each call site, so a path built tomorrow inherits it: the same reason
   *  `noteWrite` maps writes to caches in one place. The call sites encode their ids as well, which
   *  is the belt to this pair of braces.
   */
  function safePath(path) {
    const p = String(path).split('?')[0];
    if (!p.startsWith('/') || p.includes('\\') || p.includes('#') || p.split('/').includes('..')) {
      throw new Error('Refused a malformed request path - the workspace index may be damaged.');
    }
    return path;
  }
  async function api(path, csrfPrefix, retried) {
    const h = headers(csrfPrefix);
    const res = await fetch(BASE + safePath(path), { headers: h, credentials: 'include' });
    noteTokenAccepted(path, h, res);
    // 204 is an answer: «this org has none of those». It has no body, so res.json() would throw and
    // an empty area would arrive as a failure - measured on an org with no webhooks at all.
    if (res.status === 204) return NO_CONTENT;
    if (res.ok) return res.json();
    const { message, code } = await errorDetail(res);
    // **The recovery is not the deluge family's, and pinning it there put back the defect it was
    // written to end.** `_pageCsrf` outranks every cookie for *both* families and is dropped in
    // exactly one place - `warmDeluge`, reached only from here - so with the condition naming
    // `drepn`, a token Zoho rotated while the tab sat still was cleared by a Connections pull and
    // by nothing else. Every other area sent the pinned value and was refused, for the life of
    // that page, with no sentence anywhere telling the reader to reload Zoho. The refusal is the
    // same refusal whichever path it arrives on; so is the fix.
    if (!retried && res.status === 400 && message === 'INVALID_CSRF_TOKEN') {
      // Whether the primer worked is worth carrying: it is swallowed on purpose - we are after a
      // side effect and a role that refuses that endpoint is no worse off - but if it *also* failed,
      // the retry below was sent under exactly the conditions that had just been refused, and the
      // second failure is not a second piece of evidence.
      const primed = await warmDeluge();
      return api(path, csrfPrefix, primed ? true : 'unprimed');
    }
    // **The same three words for three different problems.** «400 INVALID_CSRF_TOKEN» is what you
    // get whether the deluge cookie was missing, stale, or present and rejected, and each of those
    // is a different thing to do next. The recovery above was written for one cause and measured
    // against it - the first `/deluge/` call after a fresh login - on the stated premise that «Pull
    // all never shows this, functions run first». A Pull all showed it, so that premise is now known
    // to be incomplete and the remaining cause is unidentified. Nothing is guessed here: what the
    // request actually carried is reported, so the next occurrence arrives as evidence instead of as
    // three words that fit every explanation.
    // **What the evidence decides is the sentence, and only that.** A token this session is having
    // accepted cannot be why Zoho refused: measured on a reduced-privilege user in a real org - one
    // token for the whole session, 179 answers of 200 from `/crm/`, and this endpoint refusing it
    // twice. `warmDeluge` now takes that reading rather than waiting for one, so it holds even when
    // Connections is the only area pulled.
    //
    // **It does not decide that the role is the reason, and for a while it did.** Promoting this to
    // `forbidden` hid the tab, dated a role verdict into the workspace, made later pulls skip the
    // area and suppressed the /emergency pointer - on an inference, because Zoho answered
    // INVALID_CSRF_TOKEN and never said «no permission». Worse, once the primer existed the three
    // conditions became true *by construction*: the recovery fetches the page token, the primer has
    // it accepted, the retry sends it back, so the test that was meant to mean «something else
    // accepted this» came to mean «the recovery ran». A conclusion that produces its own antecedent
    // is not a measurement. Found by a reader with no memory of writing it, reproduced against both
    // revisions with one scripted server.
    //
    // So: 401 and 403 are what Zoho *states*, and they alone are refusals. This is a failure - the
    // tab stays, later pulls retry it, /emergency is offered because a platform change is one of the
    // causes still standing - and what the reading buys is that the reader is told the calm true
    // thing instead of a cookie jar. The evidence travels as `diag` for the problem report either
    // way, which is the one place it was being lost.
    //
    // Known and not fixed: two `/deluge/` recoveries overlapping would have the second skip the
    // primer, so one failure could carry this sentence and its twin the cookie one. Nothing overlaps
    // today - `pullConnections` is the only deluge caller and `pullBusy` serialises the pulls.
    if (res.status === 400 && message === 'INVALID_CSRF_TOKEN'
        && tokenOf(h) && tokenOf(h) === _tokenAccepted && tokenOf(h) === _pageCsrf) {
      const e = apiError(res.status, path, `${message} - the same token was accepted by an ordinary `
        + 'Zoho CRM read in this session, so this is not a token fault', code);
      // The sentence the reader gets. The one built above is precise about the evidence and reads as
      // an incident; this says what it means for them, hedged where the knowledge stops.
      e.note = 'Zoho refused this read - this Zoho user may not have access to it';
      let jar = [];
      try { jar = document.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean).sort(); } catch (_) {}
      e.diag = { what: 'csrf', from: lastCsrfFrom, shape: lastCsrfShape, cookies: jar };
      throw e;
    }
    if (res.status === 400 && message === 'INVALID_CSRF_TOKEN') {
      // **Which cookies the page has, by name.** The one question this failure keeps turning on is
      // whether the deluge family's own cookie is there at all - if it is, the token is stale; if it
      // is not, everything sent is a guess and no refresh can help. A name is not a credential and no
      // value is read, so the answer can travel in the message the reader is already pasting, instead
      // of costing them a console and me another day of theories.
      let jar = [];
      try { jar = document.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean).sort(); } catch (_) {}
      const e = apiError(res.status, path,
        `${message} - the token was read from ${lastCsrfFrom} (${lastCsrfShape || 'no value'})`
        + `; cookies on this page: ${jar.join(' ') || '(none readable)'}`
        // **It names the thing that actually did not happen.** `primed` is whether the *page's own
        // token* could be read, and the sentence said «the Zoho CRM call made to refresh it failed
        // too» - about a call whose outcome is deliberately discarded, and which since the primer
        // was added is usually a 200. A false sentence in the one message somebody pastes into a
        // report is worse than no sentence.
        + (retried === 'unprimed' ? ', and the token the page itself uses could not be read either' : ', and it was still refused after a refresh'),
        code);
      // **The same three facts, carried as fields rather than as prose.** The sentence above is
      // written to be read on the status line; it does not survive the problem report, which is the
      // one place the reader was being asked to send it from. `redactHard` turns
      // `INVALID_CSRF_TOKEN` and every cookie name into `<name>` and eats the shape as a quotation -
      // correctly, since its whole job is to destroy things that look like identifiers. So the
      // report prints these instead, and they are safe by construction: two names, a count and a
      // list of names, and no value of any of them.
      e.diag = { what: 'csrf', from: lastCsrfFrom, shape: lastCsrfShape, cookies: jar };
      throw e;
    }
    throw apiError(res.status, path, message, code);
  }
  // The ZCE source endpoint answers with the file bytes as text, not JSON. Keep the same session,
  // CSRF recovery and refusal semantics as `api()`; only the successful body shape differs.
  async function apiText(path, retried) {
    const res = await fetch(BASE + safePath(path), { headers: headers(), credentials: 'include' });
    if (res.ok) return res.text();
    const { message, code } = await errorDetail(res);
    if (!retried && res.status === 400 && message === 'INVALID_CSRF_TOKEN') {
      const primed = await warmDeluge();
      return apiText(path, primed ? true : 'unprimed');
    }
    throw apiError(res.status, path, message, code);
  }

  // A **read** sent as POST, and the only one this extension makes to Zoho CRM.
  //
  // Zoho's newer functions interface addresses a function by an id this product does not hold: the
  // functions endpoint we mirror from answers ids of its own (`1453…`), and the page's URL wants the
  // id of the record in the `Functions__s` module (`5349…`). Measured on a real org, on the same
  // 100 functions: two id spaces, and Zoho's own list is what joins them - each record carries
  // `dependent_id`, which *is* the id we already have.
  //
  // The method is theirs, not a choice: that list is served by `POST /crm/v8/Functions__s/bulk` with
  // the query carrying the view, the page and the fields, and an empty body. It creates nothing -
  // the same shape as the Zoho Analytics call whose URL says `CREATE` and returns a diagram - and
  // like that one it is named on the nerd page rather than left for a reader to find. What can be
  // claimed is what Zoost *sends*; a POST is not a write because of its method, and this one asks
  // for two fields and writes nothing.
  async function apiPostJson(path, retried) {
    // An empty multipart body, which is what the page sends. `fetch` writes the boundary itself.
    const res = await fetch(BASE + safePath(path),
                            { method: 'POST', headers: headers(), body: new FormData(), credentials: 'include' });
    if (res.status === 204) return NO_CONTENT;
    if (res.ok) return res.json();
    const { message, code } = await errorDetail(res);
    if (!retried && res.status === 400 && message === 'INVALID_CSRF_TOKEN') {
      const primed = await warmDeluge();
      return apiPostJson(path, primed ? true : 'unprimed');
    }
    throw apiError(res.status, path, message, code);
  }

  /** Which record in the newer interface each mirrored function is, or nothing at all.
   *
   *  Everything here is optional by construction. An org that does not have that interface answers
   *  `INVALID_MODULE`, a role that cannot see the module is refused, and both mean the same thing to
   *  the panel: no ids, and the button keeps opening the functions list the way it always has. It is
   *  never allowed to fail a pull - what it does not know it says, and says which step did not
   *  answer, because «no ids» and «nobody asked» are different facts.
   */
  async function functionUiIds() {
    let cvid = null, step = 'view';
    try {
      // The view the module lists through. Their page reads the one it used last; a session that has
      // never opened that page has none, and then the module's own views are asked for and the
      // default is taken - which is «All Functions», and is a property of the module rather than of
      // anybody's history.
      const pref = await api('/crm/v8/settings/modules/Functions__s/actions/view_preference_configurations');
      const mods = (pref && pref.modules) || [];
      const last = ((mods[0] || {}).last_accessed_views || [])[0];
      cvid = (last && last.custom_view && last.custom_view.id) || null;
      if (!cvid) {
        step = 'views';
        const views = await api('/crm/v8/settings/custom_views?module=Functions__s');
        const all = (views && views.custom_views) || [];
        const def = all.find((v) => v.default) || all.find((v) => v.system_name === 'ALLVIEWS') || all[0];
        cvid = (def && def.id) || null;
      }
      if (!cvid) return { ok: false, why: 'no view to list the functions module through', step, map: {} };
    } catch (e) {
      return { ok: false, why: e.message, code: e.code || null, forbidden: !!e.forbidden, step, map: {} };
    }
    const map = {};
    let page = 1, capped = false;
    try {
      while (true) {
        // Two fields, which is the whole of what this is for. Its own page size, not the one the
        // other walks share: those read functions with their source and this reads two strings.
        // The endpoint is a literal at the call site on purpose: the check that holds the first
        // non-negotiable reads the call sites of this helper, and a path assembled elsewhere is a
        // path it cannot see. The shape of that check decides the shape of this line, which is the
        // right way round - a guarantee nothing can read is a sentence, not a guarantee.
        const q = `?cvid=${encodeURIComponent(cvid)}&page=${page}&per_page=${UI_ID_PAGE}`
          + '&fields=id%2Cdependent_id';
        const j = await apiPostJson('/crm/v8/Functions__s/bulk' + q);
        const rows = (j && j.data) || [];
        rows.forEach((r) => { if (r && r.dependent_id && r.id) map[String(r.dependent_id)] = String(r.id); });
        const info = (j && j.info) || {};
        if (!info.more_records || !rows.length) break;
        page++;
        // The same bound the other wide walks carry, and surfaced the same way: a list that stopped
        // early is a list that says so, because a partial map read as complete would leave a
        // function silently un-openable with nothing to explain it.
        if (page > MAX_PAGES_WIDE) { capped = true; break; }
      }
    } catch (e) {
      return { ok: false, why: e.message, code: e.code || null, forbidden: !!e.forbidden, step: 'list',
               map, partial: Object.keys(map).length > 0 };
    }
    return { ok: true, map, capped, pages: page };
  }

  /** One function's runtime record, read when somebody asks for it and never in a pull.
   *
   *  Two readings Zoho keeps per function and this mirror does not hold: the last executions - when,
   *  from what, how long, and whether they worked - and the history of who changed it. They are
   *  **per function**: on an org of three hundred that is three hundred requests, which is why this
   *  is not part of any pull and is not written to disk. It is a live lookup, and the panel says so.
   *
   *  Both may answer 204, and the two do not mean the same thing: a function nobody has run has no
   *  logs, and a compiled function has no revisions at all - measured, `revisions` returns 204 for a
   *  Node function while a Deluge one returns its whole history.
   */
  async function functionRuntime(id, language, period, from, to) {
    const fid = String(id || '').replace(/\D/g, '');
    if (!fid) return { ok: false, why: 'no function id' };
    const lang = String(language || 'deluge').replace(/[^\w]/g, '');
    // Chosen from the list, never taken from the message: what arrives here has crossed a boundary,
    // and a period goes into a URL. An unknown one falls back to the day rather than being sent.
    let win = RUNTIME_WINDOWS.includes(period) ? period : RUNTIME_WINDOWS[0];
    // A ranged window without a well-formed range is not a window: it falls back to the day rather
    // than asking Zoho for «custom» and letting them decide what that means with nothing to bound it.
    let span = '';
    if (RUNTIME_RANGED.includes(win)) {
      if (RUNTIME_STAMP.test(String(from)) && RUNTIME_STAMP.test(String(to))) {
        span = `&start_datetime=${encodeURIComponent(from)}&end_datetime=${encodeURIComponent(to)}`;
      } else { win = RUNTIME_WINDOWS[0]; }
    }
    const out = { ok: true, window: win, logs: null, revisions: null };
    try {
      const j = await api(`/crm/v2.2/settings/functions/${fid}/logs`
        + `?period=${win}${span}&page=1&per_page=${RUNTIME_LOGS}&language=${lang}`);
      out.logs = j === NO_CONTENT ? [] : list(j, 'function_logs', 'function_logs').map((r) => ({
        at: r.executed_time || null, status: r.status || null,
        // Milliseconds, as Zoho reports them. Left as the number they sent: turning it into «1.8s»
        // here would be this panel deciding what precision the reader wanted.
        ms: finiteCount(r.execution_time), from: r.component_type || null }));
    } catch (e) { out.logsWhy = e.message; }
    try {
      const j = await api(`/crm/v9/settings/functions/${fid}/revisions`);
      out.revisions = j === NO_CONTENT ? [] : list(j, 'revisions', 'revisions').map((r) => ({
        n: r.revision ?? null, at: r.modified_time || null,
        by: (r.modified_by && r.modified_by.name) || null,
        // Zoho writes this itself, in the org's language - «Creazione in corso …» from an Italian
        // org. It is shown as what it is, their sentence, and nothing is derived from it.
        message: r.commit_message || null }));
    } catch (e) { out.revisionsWhy = e.message; }
    return out;
  }

  // A file path comes from Zoho and becomes a path below the selected workspace. Refuse, rather
  // than rewrite, anything that could escape its function folder or collide after normalisation.
  function projectPath(value) {
    const p = String(value || '').replace(/\\/g, '/');
    const parts = p.split('/');
    if (!p || p.startsWith('/') || /[\x00-\x1f\x7f]/.test(p) || parts.some((x) => !x || x === '.' || x === '..')) {
      throw new Error('Zoho returned a malformed function file path; nothing was written for it.');
    }
    return parts.join('/');
  }

  function detailLanguage(language) {
    const l = String(language || 'deluge').toLowerCase();
    if (l.startsWith('java')) return 'java';
    if (l.startsWith('python')) return 'python';
    if (l.startsWith('node')) return 'nodejs';
    return 'deluge';
  }

  async function projectFiles(fn) {
    const org = orgId();
    if (!org) throw new Error('The Zoho org id is not available on this page.');
    const functionName = fn.api_name || fn.name;
    const repositoryName = fn.category || fn.nameSpace;
    if (!functionName || !repositoryName) throw new Error('Zoho did not identify the function project.');
    const base = `/crm/${encodeURIComponent(org)}/zce/function/`;
    const query = `functionName=${encodeURIComponent(functionName)}&repositoryName=${encodeURIComponent(repositoryName)}&isDeployed=false`;
    const body = await api(base + `getFileList?${query}`);
    const listed = list(body && body.data, 'functionFiles', 'zce/function/getFileList');
    const files = [];
    const directories = [];
    const seen = new Set();
    const directorySet = new Set();
    const rememberDirectory = (path) => {
      if (!directorySet.has(path)) { directorySet.add(path); directories.push(path); }
    };
    for (const item of listed) {
      const path = projectPath(item && (item.fullPath || item.id || item.text));
      if (seen.has(path)) throw new Error(`Zoho returned the function file «${path}» more than once.`);
      seen.add(path);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) rememberDirectory(parts.slice(0, i).join('/'));
      if (item && item.isDirectory) { rememberDirectory(path); continue; }
      const content = await apiText(base + `code?${query}&fileName=${encodeURIComponent(path)}`);
      files.push({ path, content });
    }
    if (!files.length) throw new Error('Zoho returned an empty function project.');
    const config = /(^|\/)config\.json$/i;
    return { files, directories, primary: (files.find((f) => !config.test(f.path)) || files[0]).path };
  }
  function toFile(fn, fallback) {
    const ns = fn.nameSpace || fallback?.namespace || fn.category || 'misc';
    const stem = (fn.api_name || fn.name || 'unknown').replace(/[^\w.\-]/g, '_');
    const meta = {
      id: fn.id, name: fn.name, display_name: fn.display_name, api_name: fn.api_name,
      nameSpace: fn.nameSpace, category: fn.category, source: fn.source,
      return_type: fn.return_type, params: fn.params || [],
      description: fn.description || '', updatedTime: fn.updatedTime, modified_by: fn.modified_by || null,
      // **Whether Zoho is running this, and whether there is an edit it is not running.** A compiled
      // function is written, saved and then *published*, so a mirror that showed only the source was
      // showing something that may never have been deployed - and both states look identical on
      // disk. Measured on an org holding one of each: `deployed_on` is epoch milliseconds as a
      // string, or `"-1"` for never, and `is_draft_available` says an unpublished edit exists. The
      // two are kept apart because they answer different questions and a published function can
      // carry a draft as well.
      //
      // `formatted_deployed_on` sits beside them in the response and is deliberately not read: it
      // is formatted in the org's own language - «ago 28, 2026» arrived from an Italian org - and
      // this product does not depend on somebody else's localised text.
      deployed_on: fn.deployed_on == null ? null : String(fn.deployed_on),
      is_draft_available: fn.is_draft_available == null ? null : !!fn.is_draft_available,
      language: fn.language || fallback?.language || 'deluge', runtime: fn.runtime || fallback?.runtime || null,
      files: null, directories: null, primary_file: null,
      associated_place: fn.associated_place ?? null, workflow: fn.workflow || '',
      rest_api: (fn.rest_api || []).map((r) => ({ type: r.type, active: r.active })),
      // Connections the function uses. connectionLinkName is the join key - the exact name that
      // appears in invokeurl [...connection:"..."], and the `name` in the org's connections catalogue.
      connections: (fn.connections || []).map((c) => ({ name: c.connectionLinkName, label: c.connectionName || c.connectionLinkName, service: c.serviceName || null, scopes: c.scopes || [] })).filter((c) => c.name),
      sv: 5,   // v5 adds `deployed_on` and `is_draft_available` - what Zoho is actually running
    };
    return { folder: ns.replace(/[^\w.\-]/g, '_'), stem, dg: fn.script || fn.workflow || '', meta };
  }
  // Metadata-only list (fast, no code) - used to show all functions immediately, then download each on demand.
  // One page-walk, asked per language. The org list is filtered by `language`, so «what functions does
  // this org have» has always meant «what Deluge functions does it have» - and Zoho serves Node ones
  // through the same endpoint now, which left an org that has them with a mirror that did not name
  // them and did not say so. That is the omission this project spends its length refusing.
  // **Every language Zoho lists, asked the way Zoho asks for it.** The value is the full versioned
  // name: `nodejs_22`, not `nodejs`, which is a different slot and empty on the org this was captured
  // from. Two guesses shipped before anything measured that - `nodejs` and `all`, both taken by
  // analogy from the *detail* call, both listing nothing on an org that has one.
  //
  // These six are what Zoho's own functions UI asks for, read off a capture of it doing so. Five of
  // them answer `204` there - «this org has none of those» - which is what they cost when empty.
  //
  // Adding the next runtime is one line. What happens when nobody adds it is handled below rather
  // than hoped about.
  const LANGUAGES = ['deluge', 'java', 'java17', 'nodejs', 'nodejs_22', 'python_3_12'];
  // Asked as well as the named ones, never instead, and only for its first page: what it answers is
  // not measured, and a walk whose behaviour is unknown must not be one the mirror depends on. It is
  // read for *reporting* only - a language it names that is not in the list above is this build
  // being short, and the panel says so. The limit, stated rather than left to be found: one page, so
  // a language whose functions all sort past it is not detected.
  const DISCOVER_LANGUAGE = 'all';
  async function listPage(language) {
    let start = 1, raw = [], pages = 0, capped = false;
    while (true) {
      const path = `/crm/v2/settings/functions?type=org&start=${start}&limit=${PAGE}&language=${encodeURIComponent(language)}`;
      const page = list(await api(path), 'functions', path);
      raw = raw.concat(page); if (page.length < PAGE) break; start += PAGE;
      if (++pages >= MAX_PAGES) { capped = true; break; }
    }
    return { raw, capped };
  }
  async function listFunctions() {
    const deluge = await listPage('deluge');
    // **The second walk cannot damage the first.** Whether this org has any, and whether this
    // endpoint answers for them the same way on every data centre, is not measured here - so a
    // refusal, a shape we cannot read, or a role that does not grant them ends as «none of those»
    // and never as a failed pull of the Deluge functions that did arrive. What is not known travels
    // as `otherFailed` rather than being rounded down to zero.
    let other = { raw: [], capped: false }, otherFailed = null;
    // **Which languages did not answer, by name.** «Something failed» is enough to refuse a prune and
    // not enough to keep a mirror working: the reader needs the rows that *did* arrive, and the panel
    // needs to know which language's previous rows to carry forward rather than treat as deleted.
    const unanswered = [];
    for (const lang of LANGUAGES) {
      if (lang === 'deluge') continue;
      try { const r = await listPage(lang); other.raw = other.raw.concat(r.raw); other.capped = other.capped || r.capped; }
      catch (e) { otherFailed = (e && e.message) || 'no answer'; unanswered.push(lang); }
    }
    // **A named list can only ever find what somebody thought of.** Six languages is what this build
    // knows about, and the day Zoho serves a seventh the mirror is short again with nothing saying
    // so: the "it answered with nothing" sentence does not fire, because the six we do ask for
    // answered. So one page of `all` is read, and any language in it that the six do not name is
    // reported under the name Zoho gives it. A finding about *this code*, printed where it can be
    // acted on, rather than an absence nobody can see.
    //
    // It is also the only measurement of `all` there has ever been: I asserted in a commit message
    // that it lists nothing, and that was a guess wearing a measurement's clothes. Nothing depends on
    // the answer - it is read, it is not merged.
    let discover = [];
    try { discover = list(await api(`/crm/v2/settings/functions?type=org&start=1&limit=${PAGE}&language=${DISCOVER_LANGUAGE}`), 'functions', 'functions'); }
    catch (_) { /* a probe answers what it can, or nothing */ }
    const known = new Set(LANGUAGES.map((x) => String(x).toLowerCase()));
    const unknownLangs = [...new Set(discover
      .map((f) => String(f.language || 'deluge'))
      .filter((l) => !known.has(l.toLowerCase())))].sort();
    // By id: a function listed twice is a row twice in the tree and two files racing for one path.
    const seen = new Set(deluge.raw.map((f) => String(f.id)));
    const extra = other.raw.filter((f) => {
      const id = String(f.id); if (seen.has(id)) return false; seen.add(id); return true;
    });
    const raw = deluge.raw.concat(extra);
    // **A language that would not answer makes this list partial, and partial is what `capped`
    // already means here.** Without it the pull wrote an entries array missing that language's rows
    // straight over `functions/index.json` and pruned against it: one 429 on the second ask and the
    // rows are gone from disk, with the warning living only in memory - reopen the panel and the
    // functions have vanished with nothing left saying why. «Does partial data authorise a
    // destructive act» is question five of the six this repository keeps, and this is its answer.
    // **And a refused language is not a capped list.** Making it one welded the constructive half of
    // the guard to the destructive one: an org whose role always refuses `nodejs_22`, or a data
    // centre that will not take `python_3_12`, got a pull that wrote nothing at all - no tree, no
    // graph, no export, no assistant - and a message telling them to try again, for ever. That is
    // worse than the defect it was written for. `capped` means «this list is short and I cannot say
    // where», which is true of a page limit and false here: what answered is complete, and the
    // panel carries the previous rows of the languages that did not.
    const capped = deluge.capped || other.capped;
    const all = raw.filter((f) => f.source !== 'extension');
    const entries = all.map((f) => ({
      id: String(f.id), api_name: f.api_name, name: f.name, display_name: f.display_name || f.api_name,
      namespace: (f.workflow && f.workflow.namespace) || f.category || 'misc',
      category: f.category, source: f.source,
      // As Zoho spells it - `nodejs_22`, not the `nodejs` that was asked for. The version is the
      // reader's business and ours: a mirror that recorded the query value would say nothing had
      // changed on the day Zoho moves it.
      language: f.language || 'deluge',
      runtime: f.runtime || null,
      rest: (f.rest_api || []).some((r) => r.active),
      // Measured on a captured list response: the org list carries `updatedTime`, and dropping it
      // here is what left «Pull all» unable to see a function edited by a colleague - the sidecar's
      // copy is from the last download, and with nothing to compare it against, nothing was stale.
      updatedTime: f.updatedTime || null,
    }));
    // What the second ask actually answered, carried whether or not it went wrong. «Zero» and «it
    // failed» are different facts, and on an org that has Node functions «zero» is the one that says
    // the request itself is wrong - which is the sentence that was missing when this shipped as a
    // guess and came back not working.
    return { total: raw.length, readable: all.length, skipped: raw.length - all.length, entries, capped,
             otherFailed, otherAsked: LANGUAGES.join(', '), otherReturned: other.raw.length,
             otherNew: extra.length, unknownLangs, unanswered };
  }
  // Workflow rules - list (metadata) and per-rule detail (conditions + actions).
  async function listWorkflows() {
    let page = 1, raw = [], capped = false;
    while (true) {
      const resp = await api(`/crm/v8/settings/automation/workflow_rules?page=${page}&per_page=200`);
      const rules = list(resp, 'workflow_rules', 'workflow_rules'); raw = raw.concat(rules);
      const info = resp.info || {}; if (!info.more_records || rules.length === 0) break; page++;
      if (page > MAX_PAGES_WIDE) { capped = true; break; }   // surfaced to the panel instead of stopping in silence
    }
    const entries = raw.map((r) => ({
      id: String(r.id), name: r.name, description: r.description || '',
      module: (r.module && r.module.api_name) || '', module_id: (r.module && r.module.id) || '',
      type: (r.execute_when && r.execute_when.type) || '', active: !!(r.status && r.status.active), source: r.source || '',
    }));
    return { total: raw.length, entries, capped };
  }
  async function fetchWorkflow(id) {
    const resp = await api(`/crm/v8/settings/automation/workflow_rules/${encodeURIComponent(id)}`);
    const rule = list(resp, 'workflow_rules', 'workflow_rules/' + id)[0]; if (!rule) throw new Error('not found');
    return { rule };
  }
  async function workflowUsage(id, fromD, tillD) {
    const resp = await api(`/crm/v8/settings/automation/workflow_rules/${encodeURIComponent(id)}/actions/usage?executed_from=${fromD}&executed_till=${tillD}&include_inner_details=related_details.sent_percentage`);
    return { usage: list(resp, 'workflow_rules', 'workflow_rules/' + id + '/actions/usage')[0] || null };
  }
  // Scheduled functions - the list already carries the called function {id, name}.
  async function fetchModuleFields(apiName) {
    const fr = await api(`/crm/v2/settings/fields?module=${encodeURIComponent(apiName)}&type=all`);
    return { fields: list(fr, 'fields', 'fields?module=' + apiName) };
  }
  async function listSchedules() {
    let page = 1, raw = [], capped = false;
    while (true) {
      const resp = await api(`/crm/v9/settings/automation/schedules?page=${page}&per_page=200`);
      const s = list(resp, 'schedules', 'schedules'); raw = raw.concat(s);
      const info = resp.info || {}; if (!info.more_records || s.length === 0) break; page++; if (page > MAX_PAGES_WIDE) { capped = true; break; }
    }
    const entries = raw.map((s) => ({
      id: String(s.id), name: s.name, status: s.status,
      function_id: (s.function && String(s.function.id)) || '', function_name: (s.function && s.function.name) || '',
      frequency: (s.frequency && s.frequency.type) || '', next: s.next_execution_time || null, last: s.last_execution_time || null,
    }));
    return { total: raw.length, entries, capped };
  }
  async function fetchOne(id, category, source, language, runtime) {
    const requested = detailLanguage(language);
    const q = []; if (category) q.push('category=' + encodeURIComponent(String(category).toLowerCase())); q.push('language=' + encodeURIComponent(requested)); if (source) q.push('source=' + encodeURIComponent(source));
    const d = await api(`/crm/v2/settings/functions/${encodeURIComponent(id)}?${q.join('&')}`); const fn = list(d, 'functions', 'functions/' + id)[0];
    if (!fn) return null;
    const file = toFile(fn, { category, source, language, runtime });
    if (requested !== 'deluge') {
      const project = await projectFiles(fn);
      file.files = project.files;
      file.directories = project.directories;
      file.primary = project.primary;
      file.meta.files = project.files.map((f) => f.path);
      file.meta.directories = project.directories;
      file.meta.primary_file = project.primary;
    }
    return file;
  }

  async function pullModules() {
    const mods = list(await api('/crm/v2/settings/modules'), 'modules', 'modules');
    const out = [];
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i]; if (!m.api_name) continue;
      // Why the fields did not come, when they did not. Both attempts used to be `catch {}`, so a
      // module Zoho refuses looked exactly like one that had never been pulled: zero fields, zero
      // layouts, zero related lists, and a panel saying "re-run Pull Modules to fetch them" - advice
      // that could not work, offered forever. Reported with a HAR: Invoices is hidden in that org and
      // Zoho answers 400 INVALID_MODULE, "operation cannot be performed for hidden module".
      //
      // Nothing here decides what that means. The status, Zoho's code and Zoho's own sentence are
      // written to the module file with the date they were given, in the same spirit as the per-area
      // access record: it is what was asked and what came back, not a permanent verdict.
      let fields = [], fieldsOk = false, unreadable = null;
      const fpath = `/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}&type=all`;
      try { fields = list(await api(fpath), 'fields', fpath); fieldsOk = true; }
      catch (e1) {
        const f2 = `/crm/v2/settings/fields?module=${encodeURIComponent(m.api_name)}`;
        try { fields = list(await api(f2), 'fields', f2); fieldsOk = true; }
        catch (e2) {
          const err = e2.status ? e2 : e1;   // the second attempt drops the URL variant, not the reason
          // Only a 4xx is a refusal: Zoho understood and said no. A dropped connection or a 5xx is a
          // failure, and dating it on disk as a settled answer would be a measurement never taken.
          const st = Number(err.status) || 0;
          // A shape that has moved is also «asked, and the answer is not usable» - a third state
          // beside refused and failed, and one that must be written down for the same reason: with
          // it absent, the module lands on disk with no fields and nothing saying why.
          if ((st >= 400 && st < 500) || err.shape) unreadable = { status: st, code: err.code || null, message: err.detail || String(err.message || err), at: new Date().toISOString() };
        }
      }
      let layouts = [];
      // Whether the answer «no layouts» was read or merely not obtained. Without it the panel cannot
      // tell a module that genuinely has none from one whose call was refused or rate-limited - and
      // it was deleting the layout detail of the second, silently, as though Zoho had said it did
      // not exist. A failed read must never authorise a deletion.
      let layoutsRead = false;
      // Only real record modules have layouts. Exact call the CRM UI uses (verified via HAR):
      // v2.2 with the comma URL-encoded (id%2Cstatus) returns every layout WITH full sections/fields.
      if (fieldsOk) { try { layouts = list(await api(`/crm/v2.2/settings/layouts?module=${encodeURIComponent(m.api_name)}&fields=id%2Cstatus`), 'layouts', 'layouts?module=' + m.api_name); layoutsRead = true; } catch (_) {} }
      // Related lists. The API name of a related list is NOT the api_name of the target module:
      // it is what zoho.crm.getRelatedRecords() / the REST /{module}/{id}/{related_list} path expect.
      let related = [];
      // The same distinction `layouts_read` makes, for the same reason: both paths ended in a silent
      // `catch`, so «this module has no related lists» and «neither endpoint would answer» arrived as
      // the same empty array. The panel then told the reader to run the pull again - which had just
      // run - instead of naming what actually happened.
      let relatedRead = false;
      if (fieldsOk) {
        try {
          const rl = list(await api(`/crm/v2/settings/related_lists?module=${encodeURIComponent(m.api_name)}`), 'related_lists', 'related_lists?module=' + m.api_name);
          related = rl.map((r) => ({
            api_name: r.api_name || r.name || null,
            label: r.display_label || r.name || r.api_name || null,
            module: (r.module && (r.module.api_name || (typeof r.module === 'string' ? r.module : null))) || null,
            type: r.type || null,
            visible: r.visible !== false,
            connected_module: (r.connectedmodule && (r.connectedmodule.api_name || r.connectedmodule)) || null,
            linking_module: (r.linking_module && (r.linking_module.api_name || r.linking_module)) || null,
            id: r.id || null, src: 'api',
          })).filter((r) => r.api_name);
          relatedRead = true;
        } catch (_) {
          // Fallback: the endpoint the CRM UI itself uses (rellistsysrefname == related list API name).
          try {
            const inst = instanceName();
            if (inst) {
              const j = await api(`/crm/${inst}/EntityFieldCustomize.do?module=${encodeURIComponent(m.module_name || m.api_name)}&isDeveloperSpace=true&isRelatedList=true`);
              const k = Object.keys(j || {})[0];
              related = (((j || {})[k] || {}).RelatedList || []).map((r) => ({
                api_name: r.rellistsysrefname || null, label: r.rellistlabel || null, module: null,
                type: r.isCustom ? 'custom' : 'default', visible: r.isVisible !== false,
                connected_module: null, linking_module: null, id: r.rellistid || null, src: 'ui',
              })).filter((r) => r.api_name);
              relatedRead = true;
            }
          } catch (_) {}
        }
      }
      out.push({
        related_lists: related,
        // Read, or merely not obtained. The panel prunes layout files against this: «none» is a fact
        // it may act on, «not read» is not.
        layouts_read: layoutsRead,
        related_read: relatedRead,
        // **Whether the fields were read at all**, which is the fact everything else here depends on:
        // when this call fails, layouts and related lists are never even attempted, so the module
        // arrives with three empty lists and nothing on it said which of «none» and «not read» that
        // was. The panel needs it before it decides to overwrite what is on disk. Same distinction
        // as the two flags above, on the one read that gates them.
        fields_read: fieldsOk,
        // null when the module read fine. Present only when Zoho refused, and then it is the whole
        // reason the three lists below are empty.
        unreadable,
        api_name: m.api_name, module_name: m.module_name || m.api_name,
        singular_label: m.singular_label || null, plural_label: m.plural_label || null,
        id: m.id, generated_type: m.generated_type || null,
        deletable: !!m.deletable, editable: !!m.editable, creatable: !!m.creatable,
        viewable: m.viewable !== false, visible: m.visible !== false,
        api_supported: m.api_supported !== false,
        layouts: layouts,   // full layout JSON (sections, fields per layout); the panel splits this into layouts/ files
        fields: fields.map((f) => ({
          api_name: f.api_name, label: f.field_label || f.display_label || f.api_name, data_type: f.data_type,
          length: f.length || null, custom: !!f.custom_field,
          mandatory: !!(f.system_mandatory || f.required || f.mandatory),
          lookup: f.lookup && f.lookup.module ? (f.lookup.module.api_name || (typeof f.lookup.module === 'string' ? f.lookup.module : null)) : null,
          picklist: (f.pick_list_values || []).map((p) => p.display_value || p.actual_value).filter(Boolean),
          id: f.id,
        })),
      });
      chrome.runtime.sendMessage({ type: 'pullProgress', done: i + 1, total: mods.length }).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
    }
    return { total: mods.length, modules: out };
  }
  // Functions-list search box (Lyte input.searchBar, maxlength=20). ONLY the stable, language-
  // independent class selector. We do not fall back to matching the placeholder text: that is
  // localized, and guessing from it is exactly the "try and hope" this tool refuses. If Zoho
  // renames this class, Find stops and says so - it does not improvise.
  // **The one thing Zoost wrote into Zoho lived here, and it is gone.**
  //
  // `Find` filled the functions list's search box: `focus()`, the native value setter, and three
  // synthetic events - a scripted interaction with a DOM contract belonging to somebody else, kept
  // as the single stated exception to the first non-negotiable. Zoho is building a new functions
  // interface addressed by URL, so the exception stopped being necessary: the panel navigates to the
  // list and stops. A reader on the old interface sees the list, which is where the typing landed
  // them anyway; a reader on the new one sees whatever that URL resolves to.
  //
  // Deliberately *not* replaced by a deep link. The new interface addresses a function by an id from
  // its own module, and the id this product holds is that record's `dependent_id` - measured across
  // fifteen functions present in two captures of one org, fifteen out of fifteen. Sending the id we
  // have would address the wrong function or none. Until that mapping is pulled, the certain thing
  // is the list.
  // The old "open the function in the Zoho editor" path lived here. It drove Zoho's DOM: it found
  // the row by matching text/attributes, fired synthetic pointer/mouse click chains on several
  // ancestors hoping a framework handler would catch, waited for a popup, then clicked a link
  // matched by its localized label ("Modifica funzione" / "Edit function"). Even with a stable
  // selector (data-zcqa="cf_editFunction") the final step is a synthetic click that triggers a Lyte
  // binding we cannot invoke ourselves - "click and hope" through a private DOM contract. It was
  // removed on principle: the panel offers Find (a deterministic filter, above) and the user opens
  // the function from Zoho's own menu, reading the label in their own language.

  // Connections catalogue: the full list of the org's connections (including ones no function uses).
  // connection.name is the join key with a function's meta.connections[].name (the connectionLinkName
  // used in invokeurl [...connection:"..."]). Same host as everything else; needs the zuid.
  // ---- automation actions: what a workflow fires, as objects in their own right ---------------
  //
  // A workflow's action is not an inline instruction: it points at a *thing* that exists on its own
  // in Zoho, has its own page, and is reused across rules. Zoost mirrored the rules and resolved
  // exactly one of the kinds - functions - and threw the rest away at the filter. Counted in one
  // real org: 275 email notification actions against 149 function ones, so the mirror was resolving
  // the less common half of the automation surface.
  //
  // Four lists, one shape: `id`, `name`, `module`, `associated`, `created_by`, `modified_by` and a
  // couple of fields of their own. They are pulled as one area and written as one index with a
  // `kind`, the way schedules and connections are one index each - not four folders, because the
  // question a reader has is «what fires this rule» and not «show me the field updates».
  //
  // `associated` is the fact that pays for the whole thing: in that same org, 85 notifications of
  // 200, 50 field updates of 97 and 27 tasks of 56 are attached to nothing. That is the measurement
  // this product already makes for functions and connections, on the objects nobody ever prunes.
  //
  // `include_inner_details` is not decoration: without it Zoho answers with the thin form of each
  // row - a notification's `from_address` arrives with a type and no resource, so the sender came
  // out as «an organisation address» and nothing else, which is a category rather than an answer.
  // Reported twice before the cause was found, because the field was *there*, only empty. Each list
  // asks for exactly what Zoho's own page asks for, read off the requests it makes rather than
  // guessed: the notification's sender, the module labels, a field's label and data type, a task's
  // rendered values, a webhook's display URL.
  const ACTION_KINDS = [
    { kind: 'email_notifications', path: '/crm/v9/settings/automation/email_notifications', key: 'email_notifications',
      detail: 'from_address.field_label,related_module.plural_label,module.plural_label' },
    { kind: 'field_updates', path: '/crm/v9/settings/automation/field_updates', key: 'field_updates',
      detail: 'module.plural_label,related_module.plural_label,display_value,field.field_label,field.data_type,dependent_field.display_value' },
    { kind: 'tasks', path: '/crm/v8/settings/automation/tasks', key: 'tasks',
      detail: 'module.plural_label,related_module.plural_label,display_value,module.singular_label' },
    { kind: 'webhooks', path: '/crm/v8/settings/automation/webhooks', key: 'webhooks',
      detail: 'display_url,related_module.plural_label,module.plural_label' },
  ];
  // Bumped when this starts capturing a field it did not before, exactly as `toFile()` does for a
  // function's meta: a row written by an older pull is missing the field rather than reporting it
  // empty, and those are different sentences. Without it, a field update pulled before `value`
  // existed read as «clears the field» - which is a statement about the org, and it was ours.
  const ACT_SV = 4;   // 4: include_inner_details, without which Zoho answers with the thin form
  // One mapping, kept as configuration rather than as a sentence. `value` is language-neutral;
  // `display` is Zoho's own words and is the fallback for a shape nobody here has seen yet.
  function mapping(m) {
    return {
      field: (m.field && m.field.api_name) || '',
      type: m.type || '',
      value: m.value === undefined ? null : m.value,
      display: m.display_value == null ? '' : String(m.display_value),
    };
  }
  function actionRow(kind, r) {
    const who = (u) => (u && u.name) || null;
    const row = {
      kind, id: String(r.id), name: r.name || '', sv: ACT_SV,
      module: (r.module && (r.module.api_name || r.module.moduleName)) || '',
      module_label: (r.module && (r.module.plural_label || r.module.singular_label)) || '',
      associated: r.associated === true,
      created_by: who(r.created_by), modified_by: who(r.modified_by),
      created_time: r.created_time || null, modified_time: r.modified_time || null,
      locked: !!(r.lock_status && r.lock_status.locked),
    };
    // Each kind adds the one or two facts that make it that kind, and nothing else. `recipient_count`
    // is a count and never the recipients; a template is named, never fetched.
    if (kind === 'email_notifications') {
      row.template = r.template ? { id: String(r.template.id || ''), name: r.template.name || '' } : null;
      // `resource` is an object - {name, email, id} - not a string. Written out whole it became
      // «[object Object]» on screen, which is the shape of bug that only a real org produces: the
      // capture said `dict(resource,type)` and nobody looked inside. The name is the display name of
      // the mailbox or the user; the address is the address, and it is the one field that travels
      // only if the reader turns it on.
      const res = (r.from_address && r.from_address.resource) || null;
      row.from_type = (r.from_address && r.from_address.type) || null;
      row.from_name = res ? (typeof res === 'string' ? null : res.name || null) : null;
      row.from_address = res ? (typeof res === 'string' ? res : res.email || null) : null;
      row.recipient_count = r.recipient_count != null ? Number(r.recipient_count) : null;
    }
    // A field update without the field and the value it writes is a name and nothing else - which is
    // what «Set stage to Won» tells you when the picklist has nine values. Measured on one org: 97 of
    // them, 69 writing a picklist, and the value is a string, a boolean or absent (which is «clear
    // it», not «unknown»). `type` was `static` on all 97; when Zoho starts returning something else,
    // it is here and the panel can say so.
    if (kind === 'field_updates') {
      row.field = (r.field && (r.field.api_name || r.field.name)) || '';
      row.field_label = (r.field && r.field.field_label) || '';
      row.field_type = (r.field && r.field.data_type) || '';
      row.value = r.value === undefined ? null : r.value;
      row.value_kind = r.value === null || r.value === undefined ? 'cleared' : (r.type || 'static');
    }
    if (kind === 'tasks') {
      row.notify = r.notify === true;
      // What the task will actually say. Zoho answers with one mapping per field, and each carries
      // **both** forms: `display_value`, already rendered in the language the org is administered in
      // («Data trigger più 7 giorni», «Non iniziato»), and `value`, which is the configuration -
      // 'Not Started', 'High', or {sign, unit, period, trigger_field}. The structure is what is kept
      // and what the panel renders, because a mirror of a configuration should not depend on the
      // language of the person who happened to pull it. The rendered string is kept beside it and
      // shown only where the structure is a shape this code does not know.
      row.mappings = (r.field_mappings || []).map(mapping).filter((m) => m.field);
    }
    // `http_method`, which is what the API calls it - `method` was a guess, and a guess that reads
    // as «this webhook has no method» rather than as a mistake.
    if (kind === 'webhooks') {
      row.method = r.http_method || r.method || '';
      row.url = r.url || r.display_url || '';
      row.description = r.description || '';
    }
    return row;
  }
  async function pullActions() {
    const out = [], missed = [], capped = [], detailMissed = [];
    for (const k of ACTION_KINDS) {
      let page = 1;
      try {
        while (true) {
          const sep = k.path.includes('?') ? '&' : '?';
          const resp = await api(`${k.path}${sep}page=${page}&per_page=200&sort_by=modified_time&sort_order=desc`
            + (k.detail ? `&include_inner_details=${encodeURIComponent(k.detail)}` : ''));
          const rows = list(resp, k.key, k.path);
          rows.forEach((r) => out.push(actionRow(k.kind, r)));
          const info = resp.info || {};
          if (!info.more_records || rows.length === 0) break;
          // 200 a page, and the org this was measured on has more than that of one kind alone. The
          // bound is the workflow list's, for the same reason - a runaway loop against somebody
          // else's pagination is not a thing to ship - and hitting it is **reported**, because a
          // list that silently stops at four thousand is a census that lies by omission.
          if (++page > MAX_PAGES_WIDE) { capped.push(k.kind); break; }   // 200 a page: the wide bound
        }
        // The task list carries five of the six mappings - the reminder is only in the task's own
        // detail, counted on a real org: 56 tasks, Subject/Due_Date/Status/Priority on every one,
        // Owner on 54, Remind_At on none. So each task is read once more, paced, exactly as the
        // workflow rules are: a list plus a detail per item. Bounded, and the bound is reported.
        if (k.kind === 'tasks') {
          const mine = out.filter((a) => a.kind === 'tasks');
          for (let i = 0; i < mine.length; i++) {
            // Beyond the bound the task is still listed - every one of them is - and only its detail
            // was not read. It used to be reported as `capped`, which the panel words as «there are
            // more in Zoho»: false, and it named a kind that does not exist, so nothing downstream
            // could match it against a row. Named by id instead, in the same list as a refusal.
            if (i >= 500) { mine[i].detail_read = false; detailMissed.push({ kind: 'tasks', id: mine[i].id, reason: 'beyond the per-pull detail bound' }); continue; }
            try {
              const one = await api(`${k.path}/${mine[i].id}`
                + (k.detail ? `?include_inner_details=${encodeURIComponent(k.detail)}` : ''));
              const t = list(one, k.key, `${k.path}/${mine[i].id}`)[0];
              if (t && t.field_mappings) mine[i].mappings = t.field_mappings.map(mapping).filter((m) => m.field);
              mine[i].detail_read = true;
            } catch (e) {
              // One task that will not answer is not the area failing - but it is not a task with no
              // mappings either, and that is what it looked like: the row went to disk thin, with a
              // current schema version, over a row that had them. Said by id so the panel can keep
              // what the last pull read of exactly this one.
              mine[i].detail_read = false;
              detailMissed.push({ kind: 'tasks', id: mine[i].id, reason: (e && e.message) || String(e) });
            }
            await new Promise((res) => setTimeout(res, 40));
          }
        }
      } catch (e) {
        // One kind refusing is not the area failing: an org may not have the feature, or the role
        // may not reach it. Say which, and keep the others.
        missed.push({ kind: k.kind, error: (e && e.message) || String(e), status: e && e.status, forbidden: !!(e && e.forbidden) });
      }
    }
    // The bridge says which schema it can write. Reloading the extension does not reload the script
    // already injected into an open Zoho tab, so a pull can run the *previous* version and write
    // rows the panel then reports as «not read by the pull that wrote this» - which is true, and
    // reads as a bug in the panel. With this, the panel can say whose copy is old.
    return { total: out.length, actions: out, missed, capped, detail_missed: detailMissed, sv: ACT_SV };
  }

  async function pullConnections() {
    const org = orgId(); const zu = zuid();
    if (!org) throw new Error('org id not found on the page');
    if (!zu) throw new Error('zuid not found on the page');
    const j = await api(`/deluge/api/ui/v1/${org}/services/ZohoCRM/connections?zuid=${zu}&flowNeeded=true&extentionPlatform=false`, 'drepn');
    const connections = list(j, 'connections', 'connections').map((c) => ({
      name: c.name, label: c.displayName || c.name,
      connector: (c.connector && c.connector.name) || null,
      connectorLabel: (c.connector && c.connector.displayName) || null,
      connected: c.isConnected !== false, createdBy: c.createdBy || null,
      scopes: c.scopes || [], id: c.id || null,
    })).filter((c) => c.name);
    return { total: connections.length, connections };
  }

  // Execution failures, and the last 24 hours of run counts. This is the one thing Zoost reads that
  // is not a photograph of a structure: a mirror says what exists, this says what is *breaking*, and
  // it changes hourly. Both are `/crm/v2/settings/functions/...`, which is a public v2 path rather
  // than one of the internal `.do` endpoints the rest of this file leans on - the most stable ground
  // in the whole extension.
  //
  // **`params` is dropped here, in the bridge, and never crosses `chrome.runtime`.** For a Workflow
  // or a Button failure it is 36 bytes - a record id. For a REST API failure it is the whole inbound
  // request: headers, the body, and a `user_info` block carrying a real person's name and email. That
  // is customer data, and Zoost says on three surfaces that it does not read any. Dropping it at the
  // boundary rather than "not writing it" downstream is the difference between a rule and a habit:
  // the panel cannot mirror what it was never handed.
  function failureRow(f) {
    const fi = f.function_info || {};
    return {
      id: String(f.failure_id || f.id || ''),
      name: fi.name || '(unnamed)', functionId: fi.id ? String(fi.id) : null,
      description: fi.description || '',
      reason: f.reason || '', count: Number(f.count) || 0,
      componentType: f.component_type || null,       // Rest API | Workflow | Button | ...
      category: f.functionCategory || null,          // the same dimension the graph colours by
      // `last_failed_time` comes back localized - "04/08/2026 02:05" in the user's own format, with
      // the timezone in `info`. It is never parsed, exactly as the Analytics dates are not: the ISO
      // field beside it is the only one that can be sorted or formatted.
      lastFailedAt: f.last_failed_time_ISO || null,
      firstFailedAt: Number(f.failed_time) ? new Date(Number(f.failed_time)).toISOString() : null,
      reRunAt: f.re_run_time && f.re_run_time !== 'null' ? f.re_run_time : null,
      // `entity_info.id` is **not** here, and the comment above says why in the paragraph about
      // `params`: for a Workflow or a Button failure that id is 36 bytes identifying a customer
      // record. It used to be captured, written into `failures/index.json`, and read by nothing -
      // not the panel, not either export, not the assistant. The same fact the boundary drops one
      // field earlier, kept one field later, for no purpose. Two rules, one line: «it never reads
      // customer records», and «never add data fetching without the UI that shows it». Found by a
      // review of this file.
    };
  }
  // One page, and it is *said*. The endpoint takes `start` and `limit`, and whether it walks past the
  // first page is not something this has ever read - a walk built on that guess would loop over the
  // same hundred rows if `start` were ignored, and produce a census by repetition. So it reads what
  // it is certain of and reports the ceiling, which is the same bargain the paged walks strike with
  // `capped`: the list may be shorter than the org, and nothing here pretends otherwise.
  const FAIL_LIMIT = 100;
  // `Number()` is not a reading: it answers 0 for `null`, for `''` and for a string of spaces, which
  // are the three shapes a field that did not come back actually arrives in. The first version of
  // this guard used `Number.isFinite(Number(x))` and let all three through as zeros - it was written
  // against `undefined`, which is the one shape that happens to fail it.
  function finiteCount(v) {
    if (v == null || (typeof v === 'string' && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  async function pullFailures() {
    const j = await api(`/crm/v2/settings/functions/failures?language=deluge&start=1&limit=${FAIL_LIMIT}&componentType=all`);
    const failures = list(j, 'custom_function_failures', 'custom_function_failures').map(failureRow);
    const capped = failures.length >= FAIL_LIMIT;
    // The run counts are aggregates - a count per hour, nothing else - so they carry no record data
    // at all and are the one half of this that costs nothing in posture.
    const to = new Date(), from = new Date(to.getTime() - 24 * 3600 * 1000);
    const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
    const usage = {};
    for (const status of ['success', 'failure']) {
      try {
        const u = await api('/crm/v2/settings/functions/dashboard/top_usage?type=usage_pattern'
          + `&component_type=functions&status=${status}&period=past_24_hours`
          + `&from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`);
        // A row with no readable count contributes nothing to a sum and says nothing about it, so
        // the total quietly comes out low - the same «unknown, never zero» this catch already states,
        // one level down, where it applies to a component of the number instead of to the number.
        // `list()` rather than `|| []`: a response with no `top_usage` at all is a shape that did not
        // answer, and summing an empty array produces a confident zero out of it.
        const counts = list(u, 'top_usage', 'top_usage').map((x) => finiteCount(x.count));
        usage[status] = counts.every((n) => n !== null) ? counts.reduce((n, c) => n + c, 0) : null;
      } catch (_) { usage[status] = null; }   // an aggregate we could not read is unknown, never zero
    }
    // How often each function actually ran, which is the measured cost the mirror can only guess at
    // from length and outbound-call counts. It is a **top list**, not the whole org - ten rows in the
    // capture this was built from - so whatever consumes it has to say so rather than presenting it
    // as a census.
    //
    // `type=function_most_credits` is NOT fetched, and that is a decision rather than an omission:
    // in the capture it returned **byte-identical** rows to `function_most_used`, so showing both
    // would put the same number on screen twice under two names and invent a distinction the data
    // does not support. If Zoho ever makes them differ, this is where to add it.
    let runs = null;
    try {
      const r = await api('/crm/v2/settings/functions/dashboard/top_usage?type=function_most_used'
        + `&period=past_24_hours&from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`);
      runs = list(r, 'top_usage', 'top_usage').map((x) => ({ id: x.function_id ? String(x.function_id) : null,
                                               name: x.value || '',
                                               // A function in the *most used* list whose count did
                                               // not read is not a function that ran zero times.
                                               count: finiteCount(x.count) }));
    } catch (_) { runs = null; }   // unknown, never an empty list: an empty one would read as «nothing ran»
    // The org's own meter for the period: what Zoho counted against the plan, and the ceiling.
    let credits = null;
    try {
      const d = await api('/crm/v2/settings/functions/dashboard?period=past_24_hours');
      const row = (d.dashboard || [])[0] || {};
      if (row.count != null || row.used != null) credits = { limit: row.count ?? null, used: row.used ?? null };
    } catch (_) { credits = null; }
    // **The same four readings over a month, beside the day.** Twenty-four hours answers «is
    // something failing right now»; it is the wrong window for «what does this org actually run» -
    // measured on a real org, one function shows 6,853 executions over a month and single digits
    // over a day, and a reader looking for what matters would have been shown the noise. The day is
    // kept because the health view already speaks in it and a number that changes meaning without
    // saying so is worse than a missing one.
    //
    // The daily rows are kept as rows, not summed. They are a thirty-point series - «when did this
    // org run, and when did it fail» - and the sum of it was the only thing this ever stored.
    let month = null;
    try {
      const mTo = new Date(), mFrom = new Date(mTo.getTime() - 30 * 24 * 3600 * 1000);
      const range = `&period=last_month&from=${encodeURIComponent(iso(mFrom))}&to=${encodeURIComponent(iso(mTo))}`;
      const daily = {};
      for (const status of ['success', 'failure']) {
        const u = await api('/crm/v2/settings/functions/dashboard/top_usage?type=usage_pattern'
          + `&component_type=functions&status=${status}${range}`);
        daily[status] = list(u, 'top_usage', 'top_usage')
          .map((x) => ({ day: x.value || '', count: finiteCount(x.count) }))
          .filter((x) => x.day);
      }
      const r = await api(`/crm/v2/settings/functions/dashboard/top_usage?type=function_most_used${range}`);
      const rows = list(r, 'top_usage', 'top_usage');
      // Zoho echoes the window it actually counted, with the *org's* timezone rather than this
      // browser's. What is stored is their answer: the dates we asked for are not necessarily the
      // days they measured, and a report that printed ours would be describing the wrong fortnight.
      const info = (r && r.info) || {};
      month = { from: info.from || null, to: info.to || null, timezone: info.timezone || null,
                // A top list, not a census. Carried as a count so whatever shows it can say so.
                top: rows.length,
                runs: rows.map((x) => ({ id: x.function_id ? String(x.function_id) : null,
                                         name: x.value || '', count: finiteCount(x.count) })),
                daily };
    } catch (_) { month = null; }   // unknown, never an empty month: an empty one reads as «nothing ran»
    return { failures, capped, usage, runs, credits, month, at: iso(to) };
  }

  // The MAIN world is the page's, so anything running in it can send this - the check is what the
  // message is allowed to *be*, not who it claims to be from. Source must be this window, the shape
  // must be exact, and the id must be digits: what it buys is that the panel re-reads one function
  // from Zoho by id, and a forged one can therefore only ask for a re-read of something that exists.
  // Nothing here writes, and nothing downstream takes the payload as content.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'DELUGE_IDE_HOOK') return;
    // Three kinds, and only three. A save and a deletion name a function, so the id is still held to
    // digits - a forged notice can therefore only ask for a re-read or a removal of something whose
    // id exists. A creation names nothing: it can only ask the panel to go and look at the list,
    // which it may do at any time anyway.
    // An orphaned content script - the extension reloaded or updated under a page opened before it -
    // has no `chrome.runtime`, and every call to it throws in Zoho's own page for an action the user
    // took. Seen for real. Said once instead of thrown.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      if (!window.__zoostOrphan) {
        window.__zoostOrphan = true;
        console.info('[zoost] this page is running an orphaned script - reload the tab');
      }
      return;
    }
    if (d.type === 'saved' || d.type === 'deleted') {
      if (!/^\d{1,20}$/.test(String(d.id || ''))) return;
      chrome.runtime.sendMessage({ type: d.type, id: String(d.id) }).catch(() => {});
      return;
    }
    if (d.type === 'created') chrome.runtime.sendMessage({ type: 'created' }).catch(() => {});
  });
  // The panel checks that the tab it is about to speak to is the right org, then awaits three times
  // before the message arrives - and by then «the active tab» may be another one. It sends what it
  // expects with the command, and this is the only party in the exchange that cannot be out of date
  // about which org it is: it *is* the page. A command that does not match is refused here.
  //
  // `context` never carries one, because it is how a mismatch is discovered in the first place.
  function expectedMatches(x, c) {
    if (!x) return true;
    if (x.workspace != null) return String(x.workspace) === String(c.workspace)
      && (!x.origin || x.origin === c.origin);
    return String(x.org) === String(c.org)
      && (!x.origin || x.origin === c.origin)
      && (!x.instance || !c.instance || x.instance === c.instance);
  }
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    // Only a real CRM-origin frame acts. With all_frames:true the scripts also load into sandboxed /
    // null-origin iframes (location.origin === 'null'), where fetch(BASE + path) becomes a relative,
    // malformed URL (…/null/crm/v2/…) → 400. Those frames must stay silent so the real CRM frame answers.
    if (!/^https:\/\/crm(sandbox)?\.zoho/.test(location.origin)) return false;
    if (msg?.cmd !== 'context' && !expectedMatches(msg && msg.__zoostExpected, context())) {
      sendResponse({ ok: false, error: 'The Zoho tab is not the one this workspace is bound to - the command was refused.' });
      return;
    }

  // An Error does not survive chrome.runtime messaging - it arrives as a plain object, and
  // `String(e)` throws away everything except the text. That is the boundary trap CLAUDE.md is about:
  // `forbidden` would be lost exactly here, and the panel would go back to guessing from a string.
  // So every handler replies through this, and the two facts travel as their own fields.
  // One reply for every command, awaited rather than chained - see `reply` in the listener.
  async function answer(p, send, shape) {
    let r;
    try { r = await p; } catch (e) { fail(send)(e); return; }
    send(shape ? shape(r) : { ok: true, ...r });
  }

  // `diag` crosses with the rest: a property hung on an Error does not survive `sendResponse`, so
  // anything the panel needs has to be named here. It carries names and counts, never a value.
  const fail = (send) => (e) => send({ ok: false, error: String(e && e.message || e), status: (e && e.status) || 0,
    forbidden: !!(e && e.forbidden), code: (e && e.code) || null, detail: (e && e.detail) || null,
    // What to say to the reader when this refusal has its own words. Without it a refusal Zoho
    // spelled differently arrives as the one generic sentence about roles, which is a cause nobody
    // measured - the trap this file keeps naming, one field along.
    note: (e && e.note) || null,
    diag: (e && e.diag) || null });

    // Only the real CRM application frame answers: CRM origin, an instance, **and an org**. The org
    // was not required, and that let a second frame speak for the tab. A suite shell puts several
    // documents on this origin - a template preview among them, at a path whose segment after `crm`
    // is the literal `html` - and `instanceName()` reads that segment, so it answered «instance:
    // html, org: null» and the panel drew «Zoho tab «html» (org null) does not match your
    // workspace»: not a refusal, a **wrong identity**, and a mismatch banner about an org the reader
    // never left. Measured on a real Zoho One tab, from the banner itself.
    //
    // The org is the right thing to require, and not one more name to exclude: it is read from the
    // page's own `crmZgid`, which only the application has, and the whole mismatch guard compares
    // orgs - so a context without one could never match anything and was never an identity.
    if (msg?.cmd === 'context') { const c = context(); if (/^https:\/\/crm(sandbox)?\.zoho/.test(c.origin || '') && c.instance && c.org) sendResponse(c); return; }
    // One reply for every command, which is the shape the Analytics bridge has had from the start.
    // Here each line carried its own `.then(...).catch(fail(...))` - eleven copies of one chain,
    // eleven scopes `tools/asynccheck.py` cannot enter, and eleven chances to write the eleventh
    // one differently from the other ten.
    // The chain lives in `answer`, a declaration, because `.then(cb)` is a scope the race checker
    // cannot enter - so what every command in this bridge did with its result was unread. Awaited
    // there instead: the same behaviour, and a checker can see it. `sendResponse` is passed rather
    // than closed over, which is what lets the work leave this listener at all.
    const reply = (p, shape) => { answer(p, sendResponse, shape); return true; };
    if (msg?.cmd === 'listFunctions') return reply(listFunctions());
    // Asked once per functions pull, after the list: it is a map from what we mirror to what the
    // newer interface calls the same function, and nothing else depends on it.
    if (msg?.cmd === 'functionUiIds') return reply(functionUiIds());
    if (msg?.cmd === 'functionRuntime') return reply(functionRuntime(msg.id, msg.language, msg.period, msg.from, msg.to));
    if (msg?.cmd === 'listWorkflows') return reply(listWorkflows());
    if (msg?.cmd === 'fetchWorkflow') return reply(fetchWorkflow(msg.id));
    if (msg?.cmd === 'workflowUsage') return reply(workflowUsage(msg.id, msg.from, msg.till));
    if (msg?.cmd === 'listSchedules') return reply(listSchedules());
    if (msg?.cmd === 'fetchModuleFields') return reply(fetchModuleFields(msg.apiName));
    if (msg?.cmd === 'fetchOne') return reply(fetchOne(msg.id, msg.category, msg.source, msg.language, msg.runtime), (file) => ({ ok: true, file }));
    if (msg?.cmd === 'pullModules') return reply(pullModules());
    if (msg?.cmd === 'pullFailures') return reply(pullFailures());
    if (msg?.cmd === 'pullActions') return reply(pullActions());
    if (msg?.cmd === 'pullConnections') return reply(pullConnections());
  });

  console.debug('[zoost] bridge active on', BASE, '· instance', instanceName(), '· org', orgId());
})();
