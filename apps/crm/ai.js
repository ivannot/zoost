/*
 * ai.js - the AI assistant, whole: configuration, key unlock, context seeding, the tool loop,
 * rendering, and the chat's own controls. Moved out of sidepanel.js as the first slice of taking
 * that file apart - it was 7,300 lines in which everything could touch everything, and this block
 * had the cleanest boundary: the rest of the panel reaches it through a dozen names (open, close,
 * clear, send, the caches dropped on a workspace change) and it reaches the rest through the
 * loaders and `beginWorkspaceOp`.
 *
 * A classic script on purpose, like tabs.js and highlight.js: top-level `let`/`const` land in the
 * page's shared lexical environment, so the two files see each other's declarations exactly as they
 * did when they were one - order decides only what runs first, and this file is declarations only.
 * It loads BEFORE sidepanel.js, whose bottom wiring assigns `aiSend` and friends to buttons at load
 * time; a function declared in a later script would arrive as `undefined` there, silently.
 */

// ---------- AI assistant (BYOK, provider-agnostic; Phase A: context chat) ----------
let aiMessages = [], moduleFilesCache = null, aiConnCache = null, aiSeedTruncated = false, aiSeedWarned = false;
// With its only consumer, and the write-path checker depends on that: it resolves a fetch's host by
// widening the constants of the *file*, so a URL declared one file away reads as «a POST to Zoho».
const OPENAI_BASE = 'https://api.openai.com/v1';
async function aiGetCfg() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = { active: c.active || 'anthropic', anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}), openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}), maxIter: c.maxIter || 20, seedCap: c.seedCap || AI_SEED_CAP_DEFAULT };
  // A protected key is on disk as ciphertext only. The plaintext lives in chrome.storage.session for
  // as long as the browser runs, and is put back here so every caller downstream sees an ordinary key
  // and nothing else has to learn about the passphrase.
  for (const prov of ['anthropic', 'openai']) {
    if (cfg[prov].apiKeyEnc && !cfg[prov].apiKey) cfg[prov].apiKey = (await window.ZOOST_KEYVAULT.recall(prov)) || '';
  }
  return cfg;
}
/** Locked = there is a key, it is encrypted, and this session has not unlocked it yet. Distinct from
 *  not-configured: the remedy is a passphrase here, not a trip to Settings. */
function aiLocked(cfg) { const p = cfg[cfg.active] || {}; return !!(p.apiKeyEnc && !p.apiKey); }
function aiActiveReady(cfg) { const p = cfg[cfg.active] || {}; return !!(p.apiKey && p.model); }

// ---------- unlocking a protected API key ----------
// The passphrase is never stored and never leaves this function: it decrypts once, the plaintext goes
// to chrome.storage.session, and the field is cleared. Forgetting it is recoverable only by entering
// the API key again - stated in Settings, and not softened here.
function aiShowLock(on) {
  const row = $('ailockrow'); if (!row) return;
  // Idempotent on purpose: this runs on every window focus and every settings change, and re-showing
  // a row that is already showing would clear a half-typed passphrase and steal the caret back.
  if (row.hidden !== !on) {
    row.hidden = !on;
    // Cleared on **both** branches. The docstring above says the passphrase «is cleared», and that
    // was true of one path: the success of `aiUnlock`. Two others left it in the DOM for the life of
    // the panel - the protection removed in Settings between showing this row and pressing Unlock,
    // which returns through `aiShowLock(false)`; and `aiEngineChrome()`, which runs on every window
    // focus and every settings change and hides the row whenever the key is no longer locked.
    //
    // It does not leave the machine and nothing reads that node. It is a sentence about a secret,
    // and it was not true of the code.
    $('ailockpass').value = '';
    if (on) { aiLockMsg(''); $('ailockpass').focus(); }
  }
}
/** A DOMException's message names the symptom and never the remedy.
 *
 * "The request is not allowed by the user agent or the platform in the current context." is what a
 * lapsed folder permission looks like from anywhere that touches the disk, and it reads as a bug in
 * the extension. It has surfaced three times now - the agent loop, and renaming a workspace - so this
 * is deliberately not AI-specific. Translated where it surfaces, so a user who meets it once more is told which button to
 * press. Nothing branches on the class name - it is matched, not parsed, and anything unrecognised is
 * passed through untouched rather than dressed up.
 */
function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not allowed by the user agent|NotAllowedError/i.test(m)) {
    return 'The working folder is no longer readable - Chrome lets that permission lapse after a while. '
      + 'Press \u21bb Refresh in the toolbar to grant it again, then ask once more. Nothing was lost.';
  }
  return MSG.errPrefix + m;
}

/** Re-grant the working folder before the assistant touches it.
 *
 * Chrome lets a File System Access permission lapse after inactivity, and every read then throws
 * `NotAllowedError: The request is not allowed by the user agent or the platform in the current
 * context.` - a message that names neither the folder nor the remedy. The AI path reads the mirror
 * directly (the seed index, the tools, the graph) and was the one path that never asked first, so it
 * surfaced as "the chat is broken until I click an item and come back": clicking an item runs
 * ensurePerm() under a real gesture and fixes it as a side effect.
 *
 * It has to happen *here*, at the click. requestPermission() needs transient user activation, so the
 * same call made inside the agent loop - after a network round trip to the model - is refused for want
 * of a gesture, which is the very error being reported. Same fix the Health view already carries.
 */
async function aiEnsureFiles() {
  if (!dir) return true;
  try { return await ensurePerm(dir); } catch (_) { return false; }
}

/** The verdict on a passphrase goes beside the field, because that is where the eye is - and because
 *  in the CRM panel the AI view covers the status bar completely, so a warning sent there while the
 *  chat is open is written to an element nobody can see. Same code on both sides regardless. */
function aiLockMsg(text) {
  const el = $('ailockmsg'); if (!el) return;
  el.textContent = text; el.hidden = !text;
}
async function aiUnlock() {
  const pass = $('ailockpass').value;
  if (!pass) { aiLockMsg('Type the passphrase you chose in Settings.'); $('ailockpass').focus(); return; }
  const cfg = await aiGetCfg();
  const prov = cfg.active; const box = (cfg[prov] || {}).apiKeyEnc;
  if (!box) { aiShowLock(false); return; }
  const key = await window.ZOOST_KEYVAULT.unlock(box, pass);
  // AES-GCM authenticates, so failure means the passphrase is wrong or the stored value is damaged.
  // Which of the two cannot be told apart, and the message says so rather than picking one.
  if (!key) {
    aiLockMsg('That passphrase did not open the key. Either it is wrong, or the stored key is damaged - the two cannot be told apart. If it is lost, open Settings and use «Remove the protection», then enter the API key again.');
    setStatus('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
  // The field is cleared here, on success, and the docstring above has always said it was. It was
  // not: `aiShowLock` empties the input only on the branch that *shows* the row, so after an unlock
  // the passphrase sat in the DOM for the life of the panel. It does not leave the machine and
  // nothing reads that node - but it is a sentence about a secret, and it was not true of the code.
  // Found by a review of the boundary.
  $('ailockpass').value = '';
  aiLockMsg(''); aiShowLock(false); setStatus('API key unlocked for this browser session.', 'ok');
}
function aiTrunc(x, n) { const s = x || ''; return s.length > n ? s.slice(0, n) + '\n\u2026 (truncated)' : s; }
async function loadModuleFiles(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (moduleFilesCache) return moduleFilesCache;
  const map = {};
  for await (const p of walk(op.root)) {
    if (!op.current()) return null;
    if (isModuleFile(p)) { try { const m = JSON.parse(await op.read(p)); map[m.api_name] = m; } catch (_) {} }
  }
  if (!op.current()) return null;
  moduleFilesCache = map; return map;
}
// Connections catalogue for the AI, joined with the functions that use each (same join key as the
// Connections tab: meta.connections[].name, the string in invokeurl [...connection:"..."]).
let aiActCache = null;
/** The automation actions and who fires them, for the assistant.
 *
 *  `addresses` decides whether the sender address travels with the answer, and it is a *setting*
 *  rather than a scope tick, because a chat has no dialog to tick: the export asks per file, this
 *  asks once. Off unless the user turned it on - the mirror keeps the address either way, and what
 *  is at stake here is whether it leaves the machine. */
/** A webhook's address, with the part that is usually a secret taken off.
 *
 *  A Zoho CRM webhook URL routinely carries a token or an API key in its query string, and this text
 *  is sent to Anthropic or OpenAI. It was the *ungated* field: the sender's email address beside it
 *  is behind a switch that is off by default, and the webhook went whole. The model has no use for
 *  the query - what it answers about is «which rule calls out, and where» - so the host and the path
 *  travel and the query is replaced by a mark that says something was there. The panel and the
 *  exports still show it in full: those are the reader's own screen and a file they choose to hand
 *  over. Found by a review of the boundary.
 */
function webhookForModel(url) {
  const u = String(url || '');
  if (!u) return '';
  const cut = u.search(/[?#]/);
  return cut < 0 ? u : `${u.slice(0, cut)}?(query withheld)`;
}
async function shareAddresses() {
  try { const c = await chrome.storage.local.get('aicfg'); return !!(c.aicfg && c.aicfg.shareAddresses); }
  catch (_) { return false; }   // unreadable is «do not share», the direction that cannot leak
}
async function aiLoadActions(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  // The list and the users are workspace data and are worth caching. **The setting is not**, and
  // caching it was a defect: `aiActCache` is dropped by a write to actions/, a write to workflows/
  // and a change of workspace - and by nothing else, so turning «share sender addresses» *off* in
  // Settings left the cached `true` answering for the rest of the browser session, and the address
  // went on travelling to the provider. A switch whose whole meaning is «does this leave the
  // machine» must not be able to be stale. Found by a review of this file.
  //
  // So it is read at the moment it is used. One `chrome.storage.local.get` per answer is nothing
  // beside the request that follows it, and there is now no third invalidation site to forget.
  if (aiActCache) return { ...aiActCache, addresses: await shareAddresses() };
  let list = []; try { const a = JSON.parse(await op.read('actions/index.json')); if (Array.isArray(a)) list = a; } catch (_) {}
  const users = actionUsers || await buildActionUsers(op);
  if (!op.current()) return null;
  aiActCache = { list, users };
  return { ...aiActCache, addresses: await shareAddresses() };
}
async function aiLoadConnections(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (aiConnCache) return aiConnCache;
  let cat = []; try { cat = JSON.parse(await op.read('connections/index.json')); } catch (_) {}
  if (!Array.isArray(cat)) cat = [];
  // A graph that failed to build is not a graph with no uses in it: `.catch(() => null)` here made
  // `get_connection` answer «used_by (0)», *and cached it*, so the invented zero outlived the error.
  // The failure propagates - the tool loop already turns a thrown tool into an error message the
  // model can read - and only the overtaken case stays silent.
  const g = await ensureGraph(op);
  if (!op.current()) return null;
  const used = {};
  Object.values(g.nodes).forEach((n) => (n.connections || []).forEach((c) => { if (c && c.name) (used[c.name] ||= []).push(n.namespace + '.' + n.name); }));
  const list = cat.map((c) => ({ ...c, uses: (used[c.name] || []).slice() }));
  const known = new Set(cat.map((c) => c.name));
  Object.keys(used).forEach((nm) => { if (!known.has(nm)) list.push({ name: nm, label: nm, connector: null, connected: null, missing: true, uses: used[nm].slice() }); });
  aiConnCache = list; return list;
}
function aiModuleText(m) {
  // Told before the empty table, not after: an assistant handed "Module Invoices" with no fields
  // will reason about why a module has none, and the answer is that nobody was ever allowed to look.
  const ref = moduleRefusal(m.unreadable);
  if (ref) return `Module ${m.api_name}\nNOT DESCRIBED BY ZOHO. ${ref.text}\nDo not infer its fields, layouts or relations from anywhere else - they were never read.\n`;
  let s = `Module ${m.api_name}\n| Field | API name | Type | Lookup | Picklist |\n`;
  (m.fields || []).forEach((f) => { s += `| ${f.label || f.api_name} | ${f.api_name} | ${(f.data_type || '') + (f.length ? ' (' + f.length + ')' : '')} | ${f.lookup ? '\u2192 ' + f.lookup : ''} | ${_pick(f.picklist, 15, (x) => x)} |\n`; });
  return s;
}
// The org, stated as compactly as it can be, in layers of decreasing importance.
//
// The index goes with *every* message, so its size is what a question costs before it has been
// asked. A large org does not fit, and the question is then not "how big a cap" but "what gets
// dropped". Cutting the tail is the wrong answer: it removes an arbitrary half and the model cannot
// tell it is missing, which is how an assistant ends up asserting a function does not exist.
//
// Functions are the vocabulary here - nothing can be answered without knowing what exists - so they
// are never dropped. Modules and connections are short and go last. Whatever is left out is named as
// left out, with the tool that finds it, so a partial index is honest rather than silently short.
const AI_SEED_CAP_DEFAULT = 72000;
let aiSeedSize = 0, aiSeedOmitted = [];

async function aiBuildSeed(cap, op = beginWorkspaceOp()) {
  cap = Math.max(4000, Number(cap) || AI_SEED_CAP_DEFAULT);
  const g = await ensureGraph(op);
  const nodes = Object.values(g.nodes).sort((a, b) => (a.namespace + '.' + a.name).localeCompare(b.namespace + '.' + b.name));
  let funcs = `## Function index (${nodes.length})\n(NNNL = source lines, Nc = outbound API calls: invokeurl + Zoho service tasks)\n`;
  nodes.forEach((n) => { const used = [...new Set((n.associated_place || []).map((p) => p._type).filter(Boolean))]; funcs += `- ${n.namespace}.${n.name}${n.rest ? ' [REST]' : ''}${used.length ? ' [' + used.join('/') + ']' : ''}${n.stats ? ` ${n.stats.lines}L ${n.stats.apiCalls}c` : ''}\n`; });

  const mods = (await loadModuleFiles(op)) || {}; const mk = Object.keys(mods).sort();
  // Marked in the index too, so a module Zoho refused is known to be unknowable before it is asked
  // about, rather than at the moment the answer would already have been guessed.
  const modules = `\n## Modules (${mk.length})\n` + mk.map((k) => '- ' + k + (mods[k] && mods[k].unreadable ? ' [not described by Zoho - fields, layouts and relations were never read]' : '')).join('\n') + '\n';

  const conns = (await aiLoadConnections(op)) || [];
  const connections = conns.length
    ? `\n## Connections (${conns.length})\n` + conns.slice().sort((a, b) => b.uses.length - a.uses.length).map((c) => `- ${c.name}${c.connector ? ' [' + c.connector + ']' : ''} \u00b7 used by ${c.uses.length} function(s)${c.connected === false ? ' \u00b7 NOT CONNECTED' : ''}${c.missing ? ' \u00b7 not in catalogue' : ''}`).join('\n') + '\n'
    : '';

  // The actions are a vocabulary too: without their names the model cannot answer «which rule sends
  // the renewal notice» except by opening rules one at a time. Counts by kind, not the whole list -
  // an org can have hundreds, and `list_actions` is one call away.
  const acts = (await aiLoadActions(op)) || { list: [], users: new Map(), addresses: false };
  const byKind = {};
  acts.list.forEach((a) => (byKind[a.kind] = (byKind[a.kind] || 0) + 1));
  const unattached = acts.list.filter((a) => !a.associated && !(acts.users.get(a.kind + ':' + String(a.id)) || []).length).length;
  const actions = acts.list.length
    ? `\n## Automation actions (${acts.list.length})\n`
      + Object.keys(byKind).sort().map((k) => `- ${actionKindLabel(k)}: ${byKind[k]}`).join('\n')
      + (unattached ? `\n- attached to no rule: ${unattached} (a candidate, not a verdict - Zoho answers for the rules it knows)` : '')
      + '\nUse `list_actions` for names, what each writes or sends, and which rules fire it.\n'
    : '';

  const omitted = [];
  let out = funcs;
  if (out.length + modules.length <= cap) out += modules; else omitted.push(`the ${mk.length} module names`);
  if (out.length + actions.length <= cap) out += actions; else if (actions) omitted.push(`the ${acts.list.length} automation actions`);
  if (out.length + connections.length <= cap) out += connections; else if (connections) omitted.push(`the ${conns.length} connections`);
  if (!op.current()) throw new Error(WS_MOVED);
  aiSeedOmitted = omitted;
  if (out.length > cap) {                 // even the function list alone overflows
    aiSeedOmitted = ['part of the function index - this org is larger than the index can hold'];
    out = aiTrunc(out, cap);
  }
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  if (omitted.length) {
    out += `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and can be fetched by name`
      + ` (list_functions, get_module, get_connection) - do not assume something is absent because`
      + ` it is not in this index.\n`;
  }
  aiSeedSize = out.length;
  return out;
}

// What the user is looking at, whatever kind of thing it is.
//
// This existed for Deluge functions only. Select a workflow, open the assistant, ask "what does this
// do?" and it answered that it had no reference and asked for details - while the same question
// about a function worked. `currentPath` was already being set by every tab; only this read it for
// one of them. Adding a tab and not extending the focus is the "one of a set" miss the conventions
// warn about, and it is invisible until someone asks the obvious question.
//
// The non-function kinds are serialised from the data actually captured rather than described field
// by field. Naming fields here would be a second description of each shape, free to drift from the
// pull that produces it - and inventing one that does not exist is how an assistant ends up
// confidently discussing something that was never there.
async function aiFocus(op = beginWorkspaceOp()) {
  const p = currentPath;
  if (!p) return '';
  const block = (what, body, lang) =>
    `\n# CURRENT FOCUS\nThe user is looking at ${what}. Answer about this unless they say otherwise.\n`
    + '```' + (lang || 'json') + '\n' + body + '\n```\n';
  try {
    if (p.endsWith('.dg')) {
      const g = await ensureGraph(op);
      const n = Object.values(g.nodes).find((x) => x.file === p);
      if (n) return block(`the Deluge function ${n.namespace}.${n.name}`, aiTrunc(await fnSource(n, op), 5000), 'deluge');
      return '';
    }
    if (p.startsWith('workflows/')) {
      const e = workflowData.find((x) => x.path === p);
      // The list entry is the index - name, module, type. What the workflow *does* is its conditions
      // and actions, and those live in the file, which is exactly what "what does this do?" asks for.
      let detail = null;
      try { detail = JSON.parse(await op.read(p)); } catch (_) {}
      if (detail || e) {
        return block(`the workflow «${(e && e.name) || (detail && detail.name) || '?'}»`,
          aiTrunc(JSON.stringify(detail || e, null, 2), 6000))
          + (detail ? '' : '\nOnly the index entry is on disk for this workflow; its conditions and actions have not been pulled.\n');
      }
    }
    if (p.startsWith('schedules/')) {
      const e = scheduleData.find((x) => x.path === p);
      if (e) return block(`the schedule «${e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    if (p.startsWith('connections/')) {
      const e = connectionData.find((x) => x.path === p);
      if (e) return block(`the connection «${e.label || e.name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 3000));
    }
    // The «one of a set» miss, again: every other kind had a branch here and this one did not, so
    // selecting an action and asking «what does this do?» got «I have no reference» while the same
    // question about a function worked. What fires it is the half of the answer that is not in the
    // row itself, so it travels with it.
    if (p.startsWith('actions/')) {
      const e = actionData.find((x) => x.path === p);
      if (e) {
        if (!actionUsers) {
          const users = await buildActionUsers(op);   // the chat may be the first thing opened
          if (!op.current()) return '';
          actionUsers = users;
        }
        const fired = actionFiredBy(e);
        // The sender address obeys the same setting here as in the index and in both exports. A
        // focus block that carried it regardless would let the address out through the one door
        // nobody thought to close - and the whole point of that switch is that it has one meaning.
        const { addresses } = (await aiLoadActions(op)) || { addresses: false };
        // `{ ...e }` sends the whole row, which is why the withholding has to name every field that
        // carries the sender rather than the one the setting is named after. `from_name` is the
        // person's own name when `from_type` is `user`, and it was going to the provider while the
        // address beside it was held back - the panel shows the two as one fact, «From», and the
        // export emits neither. The door nobody thought to close, in the block whose comment says
        // exactly that. Found by a review of this file.
        const shown = { ...e, fired_by: fired.map((r) => r.name || r.id) };
        // And the webhook's query string, for the same reason and by the same helper `list_actions`
        // uses one screen over. `webhookForModel`'s own docstring names this threat - «a Zoho CRM
        // webhook URL routinely carries a token or an API key in its query string, and this text is
        // sent to Anthropic or OpenAI» - and the fix went into the tool that lists them and not into
        // the block that focuses one. `{ ...e }` sends the row whole, so every field carrying a
        // secret has to be named here: the sender was named, the URL beside it was not.
        //
        // Unlike the sender there is no setting: the query is withheld always. What the model
        // answers about is which rule calls out and where, and the host and the path say that.
        if (shown.url) shown.url = webhookForModel(shown.url);
        const WITHHELD = '(withheld - Settings can let the assistant see the sender)';
        if (!addresses) {
          if (shown.from_address) shown.from_address = WITHHELD;
          if (shown.from_name) shown.from_name = WITHHELD;
        }
        return block(`the ${actionKindLabel(e.kind).toLowerCase().replace(/s$/, '')} \u00ab${e.name || e.id}\u00bb`,
          aiTrunc(JSON.stringify(shown, null, 2), 4000))
          + (fired.length ? '' : (e.associated
            ? '\nZoho reports it as in use, but no rule on disk names it - the rule that uses it may not have been pulled.\n'
            : '\nNo workflow rule on disk fires this action.\n'));
      }
    }
    if (p.startsWith('modules/')) {
      const e = moduleData.find((x) => x.path === p);
      if (e) {
        const ref = moduleRefusal(e.unreadable);
        return block(`the module «${e.label || e.api_name || '?'}»`, aiTrunc(JSON.stringify(e, null, 2), 6000))
          + (ref ? `\n${ref.text} Its fields, layouts and relations are absent because they were never read, not because there are none.\n` : '');
      }
    }
  } catch (_) { /* a focus that cannot be built is simply absent: never a reason to fail the chat */ }
  return '';
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website - which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPromptB(withTools, cap, op = beginWorkspaceOp()) {
  const seed = await aiBuildSeed(cap, op);
  const focus = await aiFocus(op);
  // Named from the registry, never typed. `list_actions` was added to `AI_TOOLS` and this sentence
  // was left at ten names - so the tool existed, worked, and the model was told it did not have it.
  // One of a set changed and its sibling left behind, which is the enumeration trap this repository
  // records about the site: a part is listed in as many places as it has siblings, and adding it to
  // one of them is not adding it.
  const toolsLine = withTools
    ? `You have READ-ONLY tools to explore the real org: ${AI_TOOLS.map((t) => t.name).join(', ')}. Use them to fetch exact code/schema instead of guessing or inventing. The ORG INDEX lists what exists - call tools for the details you need.`
    : 'Answer from the ORG INDEX and CURRENT FOCUS below. If you need code that is not shown, say which function/module you would need rather than inventing it.';
  return `You are an expert assistant for Zoho CRM Deluge scripting and Zoho CRM architecture, working on the user\'s real org.\n${toolsLine}\nBe precise, reference real function/module names, and follow Deluge best practices (avoid API calls in loops, guard null access, avoid hardcoded IDs).\n${productHelp()}${focus}\n# ORG INDEX\n${seed}`;
}
const AI_TOOLS = [
  // The one tool that reads a runtime rather than a structure, so its answer carries the date it was
  // read. It cannot return the input of a failed execution: that never reaches the panel.
  { name: 'list_failures', description: 'What Zoho reports as failing: the function, what invoked it (Rest API, Workflow, Button, Schedule), the reason with its line number, how many times, and when it last failed - plus how many runs and failures Zoho counted in the 24 hours before the reading, how often the busiest functions ran, and what the org spent against its ceiling. The run counts are a top list, not a census: a function absent from it was not in the busiest few, which is not the same as never having run. Says the date it was read, because this changes hourly. It cannot return the input of a failed execution: Zoost does not read it.', input_schema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'list_functions', description: 'List workspace functions with their size and outbound-call counts. Optionally filter by a substring of "namespace.name", and/or by thresholds (min_lines, min_calls) - use the thresholds to answer "how many functions are longer than N lines" exactly, instead of counting by hand. Sorted by lines, longest first.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, min_lines: { type: 'number' }, min_calls: { type: 'number' } } } },
  { name: 'get_function', description: 'Full Deluge source and metadata of a function identified by "namespace.name" (or just its name).', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'who_calls', description: 'List functions that call the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_callees', description: 'List functions called by the given function.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_code', description: 'Full-text search across all function sources; returns "namespace.name:line" matches.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_module', description: 'Field schema of a module by api_name.', input_schema: { type: 'object', properties: { api_name: { type: 'string' } }, required: ['api_name'] } },
  { name: 'get_connection', description: 'A connection by name (the string used in invokeurl [...connection:"..."]): its connector, status, scopes, and every function that uses it.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_workflow', description: 'A workflow by id or name: trigger, status, last execution, how many instant and scheduled actions it has and after how long, and the functions it calls.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_actions', description: 'List what workflow rules fire: email notifications, field updates, tasks and webhooks. Each is an object of its own in Zoho, reused across rules. Filter by kind, by module, and by unused - use unused to answer "what is attached to nothing" exactly, which is the question this list exists for. A field update says which field it writes and what value.', input_schema: { type: 'object', properties: { kind: { type: 'string' }, module: { type: 'string' }, unused: { type: 'boolean' } } } },
  { name: 'list_workflows', description: 'List workflow rules with their instant/scheduled action counts and last execution. Filter by module, by active, and by has_scheduled_actions - use that last one to answer "which and how many workflows have actions that do not run immediately" exactly, instead of opening them one by one.', input_schema: { type: 'object', properties: { module: { type: 'string' }, active: { type: 'boolean' }, has_scheduled_actions: { type: 'boolean' } } } },
];
// A tool that answers with nine hundred lines has not answered. Cap the list, say how many there
// were, and say how to narrow - the model can then ask a better question instead of drowning in the
// first one.
function aiCap(lines, total, how, limit = 120) {
  if (lines.length <= limit) return lines.join('\n');
  return lines.slice(0, limit).join('\n')
    + `\n… and ${total - limit} more (${total} in all). ${how}`;
}

/** The Deluge source of one function, read from the file it is in.
 *
 *  It used to be `n.source_code`, a field loadGraph() put on every node. That worked while the graph
 *  was built by opening every .dg and stopped the day the summary cache landed: a node served from
 *  `functions/meta-index.json` carries the references and the counts and an empty source, and after
 *  the first pull every node is served from it. So `search_code` answered «(no matches)» over an org
 *  it had never read, `get_function` returned a function with no body, and the focus block handed the
 *  model an empty fence - three tools quietly answering about nothing, which is the defect this
 *  repository already met in the Analytics `search_sql`.
 *
 *  Read once per node and kept on it, so a `search_code` over 900 functions opens each file once and
 *  a second question costs nothing. The cache dies with the graph, which is rebuilt whenever anything
 *  is written - so a re-pulled function is re-read rather than answered from memory.
 */
async function fnSource(n, op) {
  if (!n || !n.file) return '';
  if (typeof n._src === 'string') return n._src;
  let src = '';
  try { src = await op.read(n.file); } catch (_) { src = ''; }
  // The read is the await, and the node it belongs to may be from a workspace we have left by now.
  if (!op.current()) throw new Error(WS_MOVED);
  n._src = src;
  return src;
}
async function aiExecTool(name, input, op = beginWorkspaceOp()) {
  const g = await ensureGraph(op); const nodes = g.nodes; input = input || {};
  const findFn = (q) => { if (!q) return null; if (nodes[q]) return nodes[q]; const low = String(q).toLowerCase(); return Object.values(nodes).find((n) => (n.namespace + '.' + n.name).toLowerCase() === low || (n.name || '').toLowerCase() === low || (n.api_name || '').toLowerCase() === low); };
  if (name === 'list_functions') {
    const flt = (input.filter || '').toLowerCase();
    const minL = Number(input.min_lines) || 0, minC = Number(input.min_calls) || 0;
    // A function whose source is not on disk has **no** measurement, and this used to substitute
    // `{ lines: 0, apiCalls: 0 }` for it. Three harms, and the model could see none of them: it was
    // told «0 lines, 0 calls» about something unmeasured; a `min_lines` filter then dropped it
    // silently, so «every function over 50 lines» came back looking complete; and the sort put it
    // among the smallest. Unknown shown as a zero, which this product states a mirror must never do.
    const all = Object.values(nodes).map((n) => ({ id: n.namespace + '.' + n.name, s: n.stats }));
    const named = all.filter((r) => !flt || r.id.toLowerCase().includes(flt));
    const unmeasured = named.filter((r) => !r.s);
    const rows = named.filter((r) => r.s && r.s.lines >= minL && r.s.apiCalls >= minC)
      .sort((a, b) => b.s.lines - a.s.lines || a.id.localeCompare(b.id));
    const crit = [flt ? `name contains "${input.filter}"` : '', minL ? `>= ${minL} lines` : '', minC ? `>= ${minC} outbound calls` : ''].filter(Boolean).join(', ') || 'all';
    // Said whether or not anything matched: absence is only evidence when the coverage is stated.
    const gap = unmeasured.length
      ? `\n${unmeasured.length} function(s) could not be measured - their source is not in the `
        + `workspace, so they are neither included nor excluded by the size and call criteria: `
        + unmeasured.map((r) => r.id).join(', ')
      : '';
    if (!rows.length) return `0 functions match (${crit}). Total in workspace: ${Object.keys(nodes).length}.${gap}`;
    return `${rows.length} function(s) match (${crit}); ${Object.keys(nodes).length} in the workspace.\n`
      + rows.map((r) => `${r.id} - ${r.s.lines} lines, ${r.s.apiCalls} calls`).join('\n') + gap;
  }
  if (name === 'get_function') { const n = findFn(input.name); if (!n) return MSG.noFn + input.name; return `namespace.name: ${n.namespace}.${n.name}\napi_name: ${n.api_name || ''}\nreturns: ${n.return_type || ''}  REST: ${!!n.rest}\ncalls: ${(n.calls || []).join(', ') || '(none)'}\ncalled_by: ${(n.called_by || []).join(', ') || '(none)'}\nused_in: ${(n.associated_place || []).map((p) => p._type).join(', ') || '(none)'}\nconnections: ${(n.connections || []).map((c) => c.name).join(', ') || '(none)'}\nreads_modules: ${(n.modules || []).filter((m) => m.mode === 'read').map((m) => m.name).join(', ') || '(none)'}\nwrites_modules: ${(n.modules || []).filter((m) => m.mode === 'write').map((m) => m.name).join(', ') || '(none)'}${n.modulesUnknown ? `\nmodule_not_determinable_in: ${n.modulesUnknown} call(s)` : ''}\n${n.stats ? `size: ${n.stats.lines} lines (${n.stats.codeLines} code), ${n.stats.chars} chars\noutbound_calls: ${n.stats.apiCalls} (invokeurl ${n.stats.invokeurl}, zoho.crm ${n.stats.crm}, other Zoho ${n.stats.zoho}, sendmail ${n.stats.sendmail})\n` : ''}last_modified: ${n.modified_by ? 'by ' + n.modified_by : ''}${n.updatedTime ? ' ' + String(n.updatedTime).slice(0, 16) : ''}\n\n${await fnSource(n, op)}`; }
  if (name === 'who_calls') { const n = findFn(input.name); return n ? ((n.called_by || []).join('\n') || '(no callers)') : MSG.noFn + input.name; }
  if (name === 'get_callees') { const n = findFn(input.name); return n ? ((n.calls || []).join('\n') || '(no callees)') : MSG.noFn + input.name; }
  if (name === 'search_code') {
    const q = (input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = []; let unread = 0;
    for (const n of Object.values(nodes)) {
      const src = await fnSource(n, op);
      // A function whose file could not be read is not a function without the term in it. Counted and
      // said, because «no matches» over sources nobody opened is the answer this tool used to give
      // for the whole org.
      if (!src) { unread++; continue; }
      const i = src.toLowerCase().indexOf(q);
      if (i >= 0) hits.push(`${n.namespace}.${n.name}:${src.slice(0, i).split('\n').length}`);
    }
    const caveat = unread ? ` ${unread} function(s) could not be read; absence is not exhaustive.` : '';
    return hits.length ? aiCap(hits, hits.length, 'Use a longer or more specific substring.' + caveat, 60)
                       : `(no matches in ${Object.keys(nodes).length - unread} function(s))${caveat}`;
  }
  if (name === 'get_module') { const mods = (await loadModuleFiles(op)) || {}; const m = mods[input.api_name] || Object.values(mods).find((x) => (x.api_name || '').toLowerCase() === String(input.api_name).toLowerCase()); return m ? aiModuleText(m) : 'Module not found: ' + input.api_name; }
  if (name === 'list_failures') {
    let d = null; try { d = JSON.parse(await op.read('failures/index.json')); } catch (_) {}
    if (!d || !Array.isArray(d.failures)) return 'No failures have been read yet - the user runs "Pull all" or the Failures tab to fetch them.';
    const q = String(input.filter || '').toLowerCase();
    const rows = d.failures.filter((f) => !q || (f.name || '').toLowerCase().includes(q) || (f.reason || '').toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count);
    const head = `read from Zoho on ${d.at || '(unknown date)'}`
      + (d.capped ? `; ${FAIL_CAPPED}` : '')
      + (d.usage ? `; in the 24 hours before that: ${d.usage.success ?? 'unknown'} run(s), ${d.usage.failure ?? 'unknown'} failed` : '')
      + (d.credits ? `; ${d.credits.used ?? 'unknown'} counted against a ceiling of ${d.credits.limit ?? 'unknown'}` : '')
      + (Array.isArray(d.runs) && d.runs.length
          ? `. Busiest in that window (a top list, not every function): ${d.runs.slice(0, 8).map((r) => `${r.name} ${r.count == null ? '(count unknown)' : r.count + '\u00d7'}`).join(', ')}` : '')
      + '. The input of each failed run stays in Zoho and is not available here.';
    if (!rows.length) return head + '\nNothing matched.';
    return head + '\n' + aiCap(rows.map((f) => `${f.name} \u00b7 ${f.componentType || '?'} \u00b7 ${f.count}\u00d7 \u00b7 last ${f.lastFailedAt || '?'} \u00b7 ${f.reason || ''}`),
      rows.length, 'Pass a filter to narrow by function name or reason.');
  }
  if (name === 'get_connection') {
    const list = (await aiLoadConnections(op)) || [];
    const q = String(input.name || '').toLowerCase();
    const c = list.find((x) => (x.name || '').toLowerCase() === q) || list.find((x) => (x.label || '').toLowerCase() === q);
    if (!c) return 'Connection not found: ' + input.name + (list.length ? '\nKnown: ' + list.map((x) => x.name).join(', ') : '\n(no connections pulled - run Pull all)');
    return `connection: ${c.name}\nlabel: ${c.label || ''}\nconnector: ${c.connector || '(unknown)'}\n`
      + `status: ${c.missing ? 'referenced by functions but NOT in the catalogue' : c.connected === false ? 'configured but NOT connected' : 'connected'}\n`
      + `created_by: ${c.createdBy || ''}\nscopes: ${(c.scopes || []).join(', ') || '(none)'}\n`
      + `used_by (${c.uses.length}): ${c.uses.join(', ') || '(none - unused by the functions in this workspace; Flow, widgets and client scripts are not visible to Zoost)'}`;
  }
  if (name === 'list_workflows' || name === 'get_workflow') {
    // Both read the rules on disk rather than the index alone: the list endpoint returns neither the
    // scheduled actions nor the last execution, so an answer built from `workflows/index.json` would have been
    // confidently wrong about exactly the question this exists to answer.
    let idx = []; try { idx = JSON.parse(await op.read('workflows/index.json')); } catch (_) {}
    if (!idx.length) return '(no workflows in this workspace - run Pull all)';
    const rows = [];
    let unread = 0;
    for (const w of idx) {
      let det = null; try { det = JSON.parse(await op.read(`workflows/${w.id}.json`)); } catch (_) {}
      if (!det) unread++;
      const s = wfScheduled(det);
      const fns = []; const instant = [];
      ((det && det.conditions) || []).forEach((c) => {
        const ia = (c.instant_actions && c.instant_actions.actions) || [];
        ia.forEach((a) => { instant.push(a); if (isFnAction(a)) fns.push(a.name); });
        (Array.isArray(c.scheduled_actions) ? c.scheduled_actions : []).forEach((sa) =>
          (sa.actions || []).forEach((a) => { if (isFnAction(a)) fns.push(a.name); }));
      });
      rows.push({ w, det, read: !!det, sched: s.count, delays: s.delays, instant: instant.length,
                  fns: [...new Set(fns)], last: (det && det.last_executed_time) || null });
    }
    if (name === 'get_workflow') {
      const q = String(input.query || '').toLowerCase();
      const r = rows.find((x) => String(x.w.id) === input.query || (x.w.name || '').toLowerCase() === q)
             || rows.find((x) => (x.w.name || '').toLowerCase().includes(q));
      if (!r) return 'Workflow not found: ' + input.query;
      return `Workflow: ${r.w.name}\nmodule: ${r.w.module || ''}\ntrigger: ${r.w.type || ''}\n`
        + `status: ${r.w.active ? 'active' : 'inactive'}\n`
        + `last_executed: ${r.last || '(never, or not reported by Zoho)'}\n`
        + `instant_actions: ${r.instant}\n`
        + `scheduled_actions: ${r.sched}${r.sched && r.delays.length ? ' - after ' + r.delays.join(', ') : ''}\n`
        + `functions: ${r.fns.join(', ') || '(none)'}`
        + (r.read ? '' : '\nNOTE: this rule has not been downloaded, so the action and execution figures above are absent, not zero.');
    }
    const want = input.has_scheduled_actions;
    const act = input.active;
    const mod = String(input.module || '').toLowerCase();
    let sel = rows;
    if (want === true) sel = sel.filter((r) => r.sched > 0);
    if (want === false) sel = sel.filter((r) => r.read && r.sched === 0);
    if (act === true) sel = sel.filter((r) => r.w.active);
    if (act === false) sel = sel.filter((r) => !r.w.active);
    if (mod) sel = sel.filter((r) => (r.w.module || '').toLowerCase() === mod);
    const crit = [want === true ? 'with scheduled actions' : want === false ? 'without scheduled actions' : '',
                  act === true ? 'active' : act === false ? 'inactive' : '',
                  mod ? `module ${input.module}` : ''].filter(Boolean).join(', ') || 'all';
    const head = `${sel.length} workflow(s) match (${crit}); ${idx.length} in the workspace.`
      + (unread ? ` ${unread} rule(s) have not been downloaded, so they are counted as unknown rather than as zero - press «Complete missing» in the panel.` : '');
    if (!sel.length) return head;
    const lines = sel.map((r) =>
      `${r.w.name}${r.w.module ? ' [' + r.w.module + ']' : ''}${r.w.active ? '' : ' (inactive)'}`
      + ` - ${r.sched} scheduled${r.sched && r.delays.length ? ' (' + r.delays.join(', ') + ')' : ''}`
      + `, ${r.instant} instant${r.last ? ', last run ' + String(r.last).slice(0, 16) : ''}`);
    return head + '\n' + aiCap(lines, sel.length, 'Narrow with `module`, `active` or `has_scheduled_actions`.');
  }
  if (name === 'list_actions') {
    const acts = (await aiLoadActions(op)) || { list: [], users: new Map(), addresses: false };
    if (!acts.list.length) return 'No automation actions in this workspace - they are pulled with «Pull all» or from the Actions tab.';
    const kind = String(input.kind || '').toLowerCase().replace(/[\s-]/g, '_');
    let sel = acts.list;
    if (kind) sel = sel.filter((a) => a.kind === kind || actionKindLabel(a.kind).toLowerCase() === String(input.kind).toLowerCase());
    if (input.module) sel = sel.filter((a) => (a.module || '').toLowerCase() === String(input.module).toLowerCase());
    if (input.unused === true) sel = sel.filter((a) => !(acts.users.get(a.kind + ':' + String(a.id)) || []).length && !a.associated);
    if (input.unused === false) sel = sel.filter((a) => (acts.users.get(a.kind + ':' + String(a.id)) || []).length || a.associated);
    const crit = [kind ? 'kind ' + kind : '', input.module ? 'module ' + input.module : '',
                  input.unused === true ? 'attached to nothing' : input.unused === false ? 'in use' : ''].filter(Boolean).join(', ') || 'all';
    const head = `${sel.length} action(s) match (${crit}); ${acts.list.length} in the workspace.`;
    if (!sel.length) return head;
    // The sender address is deliberately absent unless the user turned it on: this text is sent to a
    // provider, and «which address» is a fact about a person in a way «a user address» is not.
    const lines = sel.map((a) => {
      const users = acts.users.get(a.kind + ':' + String(a.id)) || [];
      const extra = a.kind === 'field_updates'
        ? ` writes ${a.field || '?'} <- ${actStale(a) ? 'not read by this pull' : (a.value === null || a.value === undefined) ? 'cleared' : a.value}`
        : a.kind === 'email_notifications'
          ? ` template ${(a.template && a.template.name) || '?'}${acts.addresses && a.from_address ? ', from ' + a.from_address : a.from_type ? ', from ' + (a.from_type === 'user' ? 'a user address' : 'an organisation address') : ''}`
          : a.kind === 'webhooks' ? ` ${a.method || ''} ${webhookForModel(a.url)}`
          : a.kind === 'tasks' && actKept(a) ? ` - ${KEPT_DETAIL}`
          : a.kind === 'tasks' && actThin(a) ? ` - ${MISS_DETAIL}` : '';
      return `${a.name} [${a.kind}]${a.module ? ' on ' + a.module : ''} - fired by ${users.length} rule(s)${users.length ? ': ' + users.map((w) => w.name).join(', ') : ''}${extra}`;
    });
    return head + '\n' + aiCap(lines, sel.length, 'Narrow with `kind`, `module` or `unused`.');
  }
  return 'Unknown tool: ' + name;
}
function aiMarkdown(src) {
  const codes = [];
  let t = escHtml(src == null ? '' : src);
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => { codes.push('<pre class="aicode">' + code.replace(/\n+$/, '') + '</pre>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/`([^`\n]+)`/g, (m, c) => { codes.push('<code>' + c + '</code>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>');
  t = t.replace(/^\s*[-*]\s+(.*)$/gm, '\u2022 $1');
  // `escHtml` escapes `& < >` and not `"`, and the URL pattern admits one - so a link the model
  // writes as `[x](https://a/"style="…)` closes the href and opens an attribute of its own. The
  // model reads Deluge source from the org, which is the prompt-injection path `docs/boundaries.md`
  // names, so this string is not ours. The CSP stops an inline handler; it does not stop a `style`
  // that covers the panel, nor an href that differs from the text shown. The quote is escaped in the
  // *replacement*, by function rather than by `$2`, so nothing else in the URL is touched twice -
  // `&` has already been through escHtml and must not be encoded again.
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, text, href) => `<a href="${escQ(href)}" target="_blank" rel="noopener">${text}</a>`);
  t = t.replace(/\n/g, '<br>');
  t = t.replace(/\uE000(\d+)\uE001/g, (m, i) => codes[+i]);
  return t;
}
function aiToolArg(input) { try { const s = JSON.stringify(input || {}); return s.length > 60 ? s.slice(0, 57) + '\u2026' : s; } catch (_) { return ''; } }
function aiToolEvent(name, input) { aiMessages.push({ role: 'tool', content: `\ud83d\udd27 ${name}(${aiToolArg(input)})` }); aiRenderMessages(); }
async function aiStreamAnthropic(a, msgs, system, tools, onText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: a.model, max_tokens: 4096, system, tools, messages: msgs, stream: true }) });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const blocks = []; let stop_reason = null;
  const handle = (evt, data) => {
    if (evt === 'content_block_start') { blocks[data.index] = data.content_block.type === 'tool_use' ? { type: 'tool_use', id: data.content_block.id, name: data.content_block.name, _json: '' } : { type: 'text', text: '' }; }
    else if (evt === 'content_block_delta') { const b = blocks[data.index]; if (!b) return; if (data.delta.type === 'text_delta') { b.text += data.delta.text; onText && onText(data.delta.text); } else if (data.delta.type === 'input_json_delta') { b._json += data.delta.partial_json || ''; } }
    else if (evt === 'content_block_stop') { const b = blocks[data.index]; if (b && b.type === 'tool_use') { try { b.input = JSON.parse(b._json || '{}'); } catch (_) { b.input = {}; } delete b._json; } }
    else if (evt === 'message_delta') { if (data.delta && data.delta.stop_reason) stop_reason = data.delta.stop_reason; }
  };
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let evt = null, dataStr = '';
      chunk.split('\n').forEach((ln) => { if (ln.startsWith('event:')) evt = ln.slice(6).trim(); else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim(); });
      if (evt && dataStr) { try { handle(evt, JSON.parse(dataStr)); } catch (_) {} }
    }
  }
  const content = blocks.filter(Boolean).map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }).filter((b) => b.type !== 'text' || (b.text && b.text.trim() !== ''));
  return { content, stop_reason };
}
async function aiRunAnthropicAgent(a, apiMessages, system, tools, maxIter, current = () => true, op = beginWorkspaceOp()) {
  const msgs = apiMessages.slice();
  for (let iter = 0; iter < maxIter; iter++) {
    let bubble = null, el = null;
    const onText = (t) => {
      if (!current()) return;
      if (!bubble) { bubble = { role: 'assistant', content: '' }; aiMessages.push(bubble); aiRenderMessages(); const ns = $('aimsgs').querySelectorAll('.aimsg.assistant .aitext'); el = ns[ns.length - 1]; }
      bubble.content += t; if (el) { el.innerHTML = aiMarkdown(bubble.content); $('aimsgs').scrollTop = $('aimsgs').scrollHeight; }
    };
    const { content, stop_reason } = await aiStreamAnthropic(a, msgs, system, tools, onText);
    if (!current()) return;
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (stop_reason !== 'tool_use' || !toolUses.length) {
      if (!bubble) { const txt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); aiMessages.push({ role: 'assistant', content: txt || '(empty response)' }); aiRenderMessages(); }
      return;
    }
    msgs.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      if (!current()) return;
      aiToolEvent(tu.name, tu.input);
      let out; try { out = await aiExecTool(tu.name, tu.input, op); } catch (e) { out = MSG.errPrefix + e.message; }
      if (!current()) return;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
    }
    msgs.push({ role: 'user', content: results });
  }
  if (!current()) return;
  aiMessages.push({ role: 'assistant', content: `(Reached the tool-step limit of ${maxIter}. Raise it in Settings or ask something more specific.)` }); aiRenderMessages();
}

async function aiCall(cfg, messages, system) {
  const o = cfg.openai;
  const base = OPENAI_BASE;   // fixed: the manifest only grants host access to this endpoint
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const post = async (limitField) => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
    body: JSON.stringify({ model: o.model, messages: msgs, [limitField]: 4096 }),
  });
  // Older chat models want `max_tokens`; newer OpenAI models reject it and require
  // `max_completion_tokens`. Try the classic field, then retry once on that specific complaint.
  let res = await post('max_tokens');
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && /max_completion_tokens/.test(body)) res = await post('max_completion_tokens');
    else throw new Error(`API ${res.status}: ${aiTrunc(body, 300)}`);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const d = await res.json();
  const c = d.choices && d.choices[0];
  const txt = (c && c.message && c.message.content) || '';
  if (!txt && c && c.finish_reason === 'length') return '(The model hit the output limit before writing anything - this usually means the workspace context is too large for it. Try a model with a bigger context window.)';
  return txt;
}
let aiBusy = false;
let aiGen = 0;
function aiRenderMessages() {
  const box = $('aimsgs');
  // **Absent, not present-and-pointless, when there is nothing to clear.** Every other control here
  // disappears rather than sitting there greyed: the retry button, the per-mode rows. This one stayed
  // on an empty conversation, offering to remove nothing. Reported by the author, who had written the
  // convention it was breaking.
  $('aiclear').style.display = aiMessages.length ? '' : 'none';

  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this org\'s Deluge - I can open functions, trace callers, read module schemas, and search the code.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${escHtml(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : escHtml(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking\u2026</div>' : '');
  box.scrollTop = box.scrollHeight;
}
async function aiSend() {
  if (aiBusy) return;
  const op = beginWorkspaceOp(), gen = aiGen;
  const current = () => op.current() && gen === aiGen;
  const cfg = await aiGetCfg();
  if (!current()) return;
  aiEngineChrome();
  if (aiLocked(cfg)) { aiShowLock(true); return; }
  if (!(await aiEnsureFiles())) { setStatus('Folder access needs re-granting - press \u21bb Refresh, then ask again.', 'warn'); return; }
  if (!current()) return;
  if (!aiActiveReady(cfg)) { aiOpenSettings(); setStatus('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); setStatus('AI thinking\u2026', 'busy');
  // `finally`, not the last line. Everything from here on can exit through `if (!current())` - the
  // workspace was left, or the conversation was cleared - and each of those exits used to leave
  // `aiBusy` true and the Send button disabled *for the life of the panel*, with the «thinking…»
  // dots still on screen. Every later question then returned at the first line.
  //
  // It was reachable without changing workspace at all: `wsGen` is bumped by every activation,
  // including re-activating the one already open (↻ Refresh after a lapsed permission, the ✎ rename,
  // the capture-phase re-grant click), while the state that clears `aiBusy` is dropped only when the
  // workspace actually differs. The flag is owned by the function that sets it - the rule this
  // repository already learnt about `pullActive` - so it is released here whatever happens.
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPromptB(withTools, cfg.seedCap, op);
    if (!current()) return;
    // The org index sent to the model is capped. If it was cut, say so once - don't let the user
    // assume the model saw everything. Claude can still look things up; OpenAI (single-shot) cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large org: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools - the function list is always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific functions by name.') });
      aiRenderMessages();
    }
    if (withTools) { await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20, current, op); }
    else { const reply = await aiCall(cfg, apiMessages, system); if (!current()) return; aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    if (!current()) return;
    setStatus('', '');
  } catch (e) { if (!current()) return; aiMessages.push({ role: 'assistant', content: friendlyError(e) }); setStatus('AI error', 'warn'); }
  finally {
    // `gen === aiGen`, not unconditionally. The first version of this released whatever it found,
    // and that is a different defect rather than a fix: press **Clear** during a send and
    // `clearConversationState()` bumps `aiGen`, clears the flag and enables Send - so the next
    // question starts a second `aiSend`, and when the *first* one finally returns its `finally`
    // releases the second one's flag. A third click then runs two agent loops into one conversation.
    //
    // The rule the fix was written for is «the flag is owned by the function that sets it», and
    // ownership is the generation: if `aiGen` has moved, somebody else has already taken the flag
    // and cleared it, and this send must not touch it. If it has not moved, this send owns it and
    // releases it however it ended - including when the workspace changed under it, which is the
    // wedge the fix was for.
    if (gen === aiGen) {
      aiBusy = false;
      const send = $('aisend'); if (send) send.disabled = false;
    }
  }
  if (!current()) return;
  aiRenderMessages();
}
async function aiEngineChrome() {
  const b = $('aiengbadge'), note = $('ainote');
  if (!b || !note) return;
  const cfg = await aiGetCfg();
  aiShowLock(aiLocked(cfg));      // the chrome refresh is the one place that already re-reads the config
  if (cfg.active === 'anthropic') {
    b.textContent = 'Claude \u00b7 agent'; b.className = 'agent';
    note.className = 'ainote';
  } else {
    b.textContent = 'OpenAI \u00b7 single-shot'; b.className = 'single';
    $('ainotetxt').innerHTML = 'OpenAI answers in <b>one pass</b>: it sees the org index plus the function you have open, '
      + 'and cannot go and read other files by itself - so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before it has been
// asked. Showing it is the only way the setting that caps it can be a real choice rather than a
// number in a form: build it once, measure, and say so.
/** What the line above the chat says is focused. It read `.dg` and nothing else, so with a workflow,
 *  a module or an action open it announced that nothing was focused while aiFocus() was sending that
 *  item's detail with every message - the label contradicting the prompt, which is worse than a
 *  label that says nothing. Same one-of-a-set miss as the branches in aiFocus() itself, one line up.
 *  The name comes from the list that drew the row, so it is the name on screen. */
function aiFocusLabel() {
  const p = currentPath;
  if (!p) return null;
  if (p.endsWith('.dg')) return p.split('/').pop();
  const at = (arr, name) => { const e = (arr || []).find((x) => x.path === p); return e ? `${name} \u00ab${e.name || e.label || e.api_name || e.id}\u00bb` : null; };
  if (p.startsWith('workflows/')) return at(workflowData, 'workflow');
  if (p.startsWith('schedules/')) return at(scheduleData, 'schedule');
  if (p.startsWith('connections/')) return at(connectionData, 'connection');
  if (p.startsWith('modules/')) return at(moduleData, 'module');
  if (p.startsWith('actions/')) {
    const e = actionData.find((x) => x.path === p);
    return e ? `${actionKindLabel(e.kind).toLowerCase().replace(/s$/, '')} \u00ab${e.name || e.id}\u00bb` : null;
  }
  return null;
}
async function aiContextLabel() {
  const op = beginWorkspaceOp();
  const el = $('aictx'); if (!el) return;
  const what = aiFocusLabel();
  const focus = what ? 'Focus: ' + what
    : 'Nothing focused - open a function, a rule or an action to give the assistant its detail';
  let cost = '';
  try {
    const cfg = await aiGetCfg();
    await aiBuildSeed(cfg.seedCap, op);
    if (!op.current()) return;
    cost = ` \u00b7 sent with every message: ${((aiSeedSize + productHelp().length) / 1000).toFixed(0)}k characters, ~${Math.round((aiSeedSize + productHelp().length) / 4).toLocaleString()} tokens`
      + (aiSeedOmitted.length ? ` \u00b7 ${aiSeedOmitted.join(' and ')} left out` : '');
  } catch (_) {}
  el.textContent = focus + cost;
}
function toggleAI() {
  if ($('aiview').classList.contains('show')) { closeAI(); return; }
  if (!dir) return;
  closeHealth();   // one panel at a time
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open'); aiEngineChrome(); aiRenderMessages();
  aiEnsureFiles().then(() => aiContextLabel());   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it - switching workspace does it too, because the old thread was about another org.')) return; clearConversationState(); }
// AI configuration lives in the options page now: the side panel is 400px wide and these are
// set-once fields. openSettings() focuses the one settings window; the panel picks the change up via
// chrome.storage.onChanged.
function aiOpenSettings() { openSettings('#ai'); }   // sent from the assistant, so land on its section
