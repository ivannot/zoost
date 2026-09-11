/*
 * ai.js - the Analytics assistant, isolated from panel navigation and rendering.
 *
 * A classic script loaded before sidepanel.js. Its declarations keep the shipped global-script
 * contract; the panel owns wiring while this file owns assistant state, tools and provider calls.
 */
// ---------- AI ----------
// Ported from the CRM panel: same config shape, same storage key, same streaming agent loop, same
// single-shot OpenAI path with the max_tokens/max_completion_tokens retry. What differs is what the
// tools read - views, columns, relations, SQL and lineage instead of functions and modules - and the
// SQL guardrail, which is the one thing here not derived from the user's own workspace.
let aiMessages = [];
let aiBusy = false, aiSeedTruncated = false, aiSeedWarned = false, aiSeedOmitted = [];
let aiGen = 0;

async function aiGetCfg() {
  let c = {}; try { const r = await chrome.storage.local.get('aicfg'); c = r.aicfg || {}; } catch (_) {}
  const cfg = { active: c.active || 'anthropic', anthropic: Object.assign({ model: '', apiKey: '' }, c.anthropic || {}), openai: Object.assign({ model: '', apiKey: '' }, c.openai || {}), maxIter: c.maxIter || 20, seedCap: c.seedCap || AI_SEED_CAP_DEFAULT, maxTokens: c.maxTokens || AI_MAX_TOKENS_DEFAULT };
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
  const structured = {
    'upstream-unavailable': 'Zoho is temporarily unavailable - try again in a moment.',
    'rate-limited': 'Zoho is rate-limiting requests - wait a moment, then try again.',
    'upstream-contract': 'Zoho returned data this version does not understand - no mirror change was made.',
    authentication: 'Zoho rejected the session - reload the Zoho tab, then try again.',
    permission: 'Zoho refused this operation for the current role.',
    configuration: 'This feature is not configured - open Settings to complete it.',
  };
  if (e && structured[e.uiKey]) return structured[e.uiKey];
  const m = (e && e.message) || String(e);
  if (/not allowed by the user agent|NotAllowedError/i.test(m)) {
    return 'The working folder is no longer readable - Chrome lets that permission lapse after a while. '
      + 'Press \u21bb Refresh in the toolbar to grant it again, then run it again. Nothing was written.';
  }
  // **The caller says what failed; this says why.** The prefix was added here and every caller
  // already leads with its own sentence, so the status line read «Functions pull error: Error:
  // Zoho refused the request» - and the branch above never carried it anyway, so the two halves
  // of this function did not even agree. The two places that show it bare add the marker
  // themselves.
  return m;
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
    status('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
  // Cleared here, on success, as the docstring has always said. It was not: `aiShowLock` empties the
  // input only on the branch that *shows* the row, so the passphrase sat in the DOM for the life of
  // the panel. Found by a review of the boundary; the CRM twin had it too.
  $('ailockpass').value = '';
  aiLockMsg(''); aiShowLock(false); status('API key unlocked for this browser session.', 'ok');
}
function aiTrunc(x, n) { const t = x || ''; return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }

// A `function`, not a multi-line arrow: the slicer lifts declarations, and an arrow-const is cut at
// its first line - the rule slice.mjs already states, met here by the registry-derived tool test.
/** What is known about one view's SQL - one answer, four values, used by every surface.
 *  «Not read» and «absent» were one fact: a QueryTable whose pull failed was missing from `sqls`,
 *  so get_sql said it was «not a query table», searches said «no matches» over queries they never
 *  opened, and the exports skipped it whole. Reproduced by an outside scan.
 *    not-query   - the view is not a QueryTable at all
 *    read        - the SQL is here (an *empty* query is still `read`; emptiness is Zoho's answer)
 *    unread      - the pull failed for this one, or the mirror lost the file; `error` says which */
function sqlState(id) {
  const v = viewById().get(id);
  if (!v || v.type !== 'QueryTable') return { kind: 'not-query' };
  const failure = (pullFailed || []).find((f) => String(f.id) === String(id) && f.stage === 'sql');
  if (failure) return { kind: 'unread', error: failure.error || 'the pull could not read it' };
  if (sqlDiskUnread.has(String(id))) return { kind: 'unread', error: 'the .sql file could not be read' };
  const q = sqls[id];
  if (!q) return { kind: 'unread', error: 'its SQL is missing from the mirror' };
  return { kind: 'read', query: q };
}
function aiFindView(q) {
  if (!q) return null;
  const low = String(q).toLowerCase();
  return views.find((v) => v.id === String(q)) || views.find((v) => (v.name || '').toLowerCase() === low)
    || views.find((v) => (v.name || '').toLowerCase().includes(low)) || null;
}
function aiStructureText(v) {
  const m = viewById();
  const chain = structureChain(v, m);
  // A structure that is not here because a file would not open is not a structure that is not there.
  if (!chain) return `${v.name} (${v.type}) has no columns and no reachable source.` + aiMirrorShort();
  const src = chain[chain.length - 1], t = schema[src.id];
  const { out, inc } = foreignKeys(src.id);
  let s2 = `${src.name} (${t.kind}${t.system ? ', system table - synced by Zoho, not built by the user' : ''})`;
  if (chain.length > 1) s2 += `\n(structure inherited by ${v.name} through ${chain.slice(0, -1).map((c) => c.name).join(' → ')})`;
  s2 += '\n| Column | Type | References |\n';
  t.columns.forEach((c) => {
    const refs = [].concat((out.get(c.name) || []).map((f) => `→ ${f.name}.${f.column}`), (inc.get(c.name) || []).map((f) => `← ${f.name}.${f.column}`)).join(', ');
    s2 += `| ${c.name} | ${c.type} | ${refs} |\n`;
  });
  return s2;
}

// The workspace, stated as compactly as it can be, in layers of decreasing importance.
//
// A workspace of a thousand views does not fit in a system prompt sent with every message, so the
// question is not "how big a cap" but "what gets dropped when it does not fit". Dropping the tail is
// the wrong answer: it cuts an arbitrary half and the model cannot tell it is missing.
//
// The order below is the answer. Data objects are the vocabulary - you cannot write a query, follow
// a foreign key or judge whether something already exists without knowing the tables, so they are
// never dropped. Reports and dashboards are findable by name through list_views, so they go first if
// something must. Whatever is left out is *named as left out*, in the prompt itself, with what to
// call instead - an index that is silently short is worse than one that is honestly partial.
const AI_SEED_CAP_DEFAULT = 72000;
// What one answer may cost, and it is the reader's to set. It was 4096, written here when a model
// answered straight away - and a model that reasons first spends this on the reasoning: measured
// from a real question, 4,096 output tokens, **every one of them thinking**, `stop_reason:
// max_tokens`, and not a character of answer. The panel then said «(empty response)».
//
// 16384 because the failure is silent and the cost of the ceiling being too low is a wasted call,
// while the cost of it being too high is only the tokens actually used. The number itself has not
// been measured against a real workload here - it is a starting point, and it is in Settings.
const AI_MAX_TOKENS_DEFAULT = 16384;
let aiSeedSize = 0;                     // what the last index actually came to, shown in the chat

async function aiBuildSeed(cap, op = beginWorkspaceOp()) {
  // Said once at the top as well as on the answers: a model that knows the mirror is short can
  // decline to conclude before it asks, instead of being corrected after.
  const shortHead = (diskUnreadableAll || []).length
    ? `## This workspace is short\n${diskUnreadableAll.map((f) => f.rel).join(', ')} would not open, so what `
      + 'they hold is missing from everything below. Never state an absence as a fact about Zoho '
      + 'while this is true.\n\n'
    : '';
  if (!op.current()) throw new Error(WS_MOVED);
  cap = Math.max(4000, Number(cap) || AI_SEED_CAP_DEFAULT);
  const m = viewById();
  const byType = new Map();
  for (const v of views) byType.set(v.type, (byType.get(v.type) || 0) + 1);
  const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);

  const header = `Workspace: ${bound ? (bound.name || bound.workspace) : '?'} (id ${bound ? bound.workspace : '?'})\n`
    + `${views.length} views - ` + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') + '\n'
    + `${Object.keys(schema).length} data objects, ${cols} columns, ${relations.length} relations`
    + (deps ? `, ${views.filter(isOrphanCandidate).length} nothing depends on` : ', lineage not pulled') + '\n'
    + '\nKey: [T] table, [Q] query table, sys = put there by Zoho not by the user, Nc = columns.\n'
    + 'Report types: [A] AnalysisView, [P] Pivot, [R] Report, [S] SummaryView.\n';

  const tables = `\n## Tables and query tables (${Object.keys(schema).length})\n`
    + Object.entries(schema).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([, t]) => `${t.name} [${t.kind === 'QueryTable' ? 'Q' : 'T'}${t.system ? ',sys' : ''}] ${t.columns.length}c`).join('\n') + '\n';

  const pres = views.filter((v) => !schema[v.id] && v.type !== 'Dashboard');
  let reports = '';
  if (pres.length) {
    const byParent = new Map();
    for (const v of pres) {
      const p = v.parent && m.get(v.parent) ? m.get(v.parent).name : '(unknown source)';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(`${v.name} [${v.type[0]}]`);
    }
    reports = `\n## Reports and pivots (${pres.length}), grouped by what they are built on\n`
      + [...byParent.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([p, list]) => `${p} → ${list.join(', ')}`).join('\n') + '\n';
  }
  const dashList = views.filter((v) => v.type === 'Dashboard');
  const dashboards = dashList.length ? `\n## Dashboards (${dashList.length})\n` + dashList.map((v) => v.name).join(', ') + '\n' : '';

  // Assemble in priority order, and record what did not fit rather than letting it vanish.
  const omitted = [];
  // Ahead of the header, and never truncated away: it is the one line that stops everything below
  // being read as a statement about the org.
  let out = shortHead + header + tables;
  if (out.length + reports.length <= cap) out += reports;
  else if (reports) omitted.push(`the ${pres.length} reports and pivots`);
  if (out.length + dashboards.length <= cap) out += dashboards;
  else if (dashboards) omitted.push(`the ${dashList.length} dashboards`);

  if (!op.current()) throw new Error(WS_MOVED);
  // One list, read by both readers, and the note counted against the ceiling. This used to
  // **replace** `aiSeedOmitted` when the table list alone overflowed, while the note inside the
  // index went on naming only what had been dropped before that - so the panel said «part of the
  // table list» and the index said «the 30 reports and pivots», and the model was never told the one
  // absence that changes its answers. It also appended the note *after* truncating, which put the
  // seed back over the cap: measured at 4,222 against 4,000, with 700 tables.
  //
  // The CRM twin was corrected first and this was not, in a session about fixes that reach one half
  // of a pair. Reported from outside, with that number.
  if (out.length > cap) omitted.unshift('part of the table list - this workspace is larger than the index can hold');
  aiSeedOmitted = omitted;
  const note = omitted.length
    ? `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and you can find them by name`
      + ` with list_views (it takes a name substring and a type) - do not assume a view is absent`
      + ` because it is not in this index.\n`
    : '';
  // `aiTrunc` adds its own «(truncated)» marker, so the room to leave is the note and that.
  const MARK = '\n\u2026 (truncated)'.length;
  if (out.length + note.length > cap) out = aiTrunc(out, Math.max(0, cap - note.length - MARK));
  out += note;
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  aiSeedSize = out.length;
  return out;
}

// The extension's own help, so "how do I export this?" is answered where the user already is
// rather than by sending them to a website - which would move the question rather than answer it.
// Guarded: a missing script must cost the product primer, never the whole assistant.
function productHelp() {
  try { return '\n' + window.ZOOST_PRODUCT_HELP.text() + '\n'; } catch (_) { return ''; }
}

async function aiSystemPrompt(withTools, cap, op = beginWorkspaceOp()) {
  const seed = await aiBuildSeed(cap, op);
  let focus = '';
  const cur = selectedId ? viewById().get(selectedId) : null;
  if (cur) {
    focus = `\n# CURRENT FOCUS\nThe user is looking at ${cur.name} (${cur.type}).\n${aiStructureText(cur)}\n`;
    const st = await sqlReadState(cur.id, op);
    if (st.kind === 'unread') focus += `\nIt is a query table whose SQL could not be read - do not conclude anything from its absence.`;
    if (st.kind === 'read') focus += `\nIts SQL:\n\u0060\u0060\u0060sql\n${aiTrunc(sqlText(st.body), 4000)}\n\u0060\u0060\u0060\n`;
  }
  const toolsLine = withTools
    // Named from the registry, never typed. This list is complete today by care alone, and the
    // CRM twin's was not: `list_actions` was added there and the sentence stayed at ten names.
    ? `You have READ-ONLY tools over the local mirror: ${AI_TOOLS.map((t) => t.name).join(', ')}. Use them to fetch exact structure and SQL instead of guessing. get_view returns the whole dossier for one view - structure, foreign keys, SQL and lineage - so prefer it over three narrower calls, and prefer search_columns or search_sql over opening views one at a time.`
    : 'Answer from the WORKSPACE INDEX and CURRENT FOCUS below. If you need a structure or a query that is not shown, say which view you would need rather than inventing it.';
  return `You are an expert assistant for Zoho Analytics, working on the user\'s real workspace.\n${toolsLine}\n`
    + `Reference real view and column names. Zoost is read-only: it never creates, edits or deletes anything in Zoho Analytics, and it never reads the rows in a table - so you know structure, relations and SQL, never data values. Never claim to know what is in the data.\n`+ `If a query table's SQL comes back as unreadable or empty, say so and stop there. Do not reconstruct what a query probably does from column names and lineage and present it as its logic - a plausible reconstruction of code the user cannot check is worse than \"I could not read it\".\n\n`
    + `${window.ZOHO_ANALYTICS_SQL.text()}\n`
    + `${productHelp()}${focus}\n# WORKSPACE INDEX\n${seed}`;
}

const AI_TOOLS = [
  { name: 'list_views', description: 'List views in the workspace. Optionally filter by a substring of the name, by type (Table, QueryTable, Pivot, AnalysisView, SummaryView, Report, Dashboard), and/or by a minimum column count.', input_schema: { type: 'object', properties: { filter: { type: 'string' }, type: { type: 'string' }, min_columns: { type: 'number' } } } },
  { name: 'get_view', description: 'THE DOSSIER for one view, in a single call: type, folder, owner, dates, what it is built on, its full column list with data types and foreign keys, its SQL if it is a query table, its relations, and what reads from it. Prefer this over calling get_structure, get_sql and who_uses separately.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_structure', description: 'Columns and Zoho data types of a table or query table, with each column\'s foreign keys in both directions. For a report or pivot, returns the structure it inherits and says so.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_sql', description: 'The SQL source of a query table, with the source tables and the columns it involves.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'search_sql', description: 'Full-text search across every query table\'s SQL. Returns the view names that match.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'search_columns', description: 'Find which tables have a column whose name matches. Use this to answer "where is this data" before writing a query.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_relations', description: 'Relations (joins) a table takes part in, in both directions, as Zoho writes them. Omit the name for the whole workspace.', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'who_uses', description: 'What reads from a view, transitively, plus the dashboards it appears on.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'orphans', description: 'Views that nothing in the workspace depends on. Candidates, not a verdict.', input_schema: { type: 'object', properties: {} } },
];

// A tool that answers with nine hundred lines has not answered. Cap the list, say how many there
// were, and say how to narrow - the model can then ask a better question instead of drowning in the
// first one.
function aiCap(lines, total, how, limit = 120) {
  if (lines.length <= limit) return lines.join('\n');
  return lines.slice(0, limit).join('\n')
    + `\n… and ${total - limit} more (${total} in all). ${how}`;
}

// **What this mirror could not read, said to the surface that answers in words.** The load already
// knows: `diskUnreadableAll` holds every file that would not open, and the panel's own line names
// them. The assistant's tools did not ask, so with `schema.json` unreadable they answered «Orders has
// no columns and no reachable source» and «Orders takes part in no relation» - categorical, about a
// table whose structure is in Zoho and was pulled. That is the sentence somebody deletes a view over.
//
// It is not the twin's defect arriving late: the same miss was made in the CRM one absence earlier
// and fixed there, and this is the third surface of this product to be told - after the panel and
// before nothing, because the exports read their own counts.
const AI_STRUCTURE_FILES = ['schema.json', 'relations.json'];
function aiMirrorShort(kind) {
  const rel = (diskUnreadableAll || []).map((f) => f.rel);
  if (!rel.length) return '';
  const mine = rel.filter((r) => AI_STRUCTURE_FILES.some((f) => String(r).endsWith(f)));
  const which = (kind === 'any' ? rel : mine);
  return which.length
    ? `\n\nThis workspace is short: ${which.join(', ')} would not open, so what it holds is missing from `
      + 'the answer above. Do not read an absence here as an absence in Zoho - press \u21bb Refresh, or Pull all.'
    : '';
}
async function aiExecTool(name, input, op = beginWorkspaceOp()) {
  input = input || {};
  const m = viewById();
  if (name === 'list_views') {
    const f = (input.filter || '').toLowerCase(), ty = (input.type || '').toLowerCase(), minc = Number(input.min_columns) || 0;
    const rows = views.filter((v) => (!f || (v.name || '').toLowerCase().includes(f)) && (!ty || (v.type || '').toLowerCase() === ty)
      && (!minc || (schema[v.id] ? schema[v.id].columns.length : 0) >= minc));
    if (!rows.length) return `0 views match. ${views.length} in the workspace.` + aiMirrorShort('any');
    const lines = rows.map((v) => `${v.name} [${v.type}]${schema[v.id] ? ' ' + schema[v.id].columns.length + ' cols' : ''}${v.folderName ? ' · ' + v.folderName : ''}`);
    return `${rows.length} of ${views.length} views:\n`
      + aiCap(lines, rows.length, 'Narrow with `filter` (a name substring), `type`, or `min_columns`.');
  }
  // Global tools take a `query`, not a view: resolving `input.name` first answered
  // «View not found: undefined» for both searches, so two tools the system prompt advertises had
  // never once run. Reproduced by an outside scan; a registry-derived test now runs every tool.
  const GLOBAL = name === 'orphans' || name === 'search_sql' || name === 'search_columns';
  const v = GLOBAL ? null : aiFindView(input.name);
  if (!v && !GLOBAL && !(name === 'get_relations' && !input.name)) return 'View not found: ' + input.name;
  if (name === 'get_view') {
    // Everything about one view in one step. It used to answer the metadata alone, so any real
    // question cost three or four calls - which is how a limit of eight ran out on a single
    // question. The tools are the expensive part of an agent loop; making each one answer more is
    // worth more than adding steps.
    const d = deps && deps[v.id];
    let out = `${v.name}\ntype: ${v.type}\nfolder: ${v.folderName || '(none)'}\nowner: ${v.owner || ''}\n`
      + `built_on: ${v.parent && m.get(v.parent) ? m.get(v.parent).name : '(nothing - it is a data object)'}\n`
      + `design_changed: ${v.designModifiedAt ? shortDate(v.designModifiedAt) : v.designModifiedText + ' (Zoho\'s own text, not machine-readable)'}\n`
      + `data_changed: ${shortDate(v.dataModifiedAt)}\n`
      + `system_table: ${!!v.system}\ndescription: ${v.description || '(none)'}\n`;
    out += '\n' + aiStructureText(v) + '\n';
    const rs = relationsOf(v.id);
    if (rs.length) out += `\nrelations (${rs.length}):\n` + rs.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`).join('\n') + '\n';
    const st = await sqlReadState(v.id, op);
    if (st.kind === 'unread') out += `\nSQL could not be read (${st.error}) - do not conclude anything from its absence.\n`;
    else if (st.kind === 'read') {
      const src = Object.entries(st.query.sources || {}).map(([, sd]) => `${sd.name} (${sd.columns.length} columns involved)`).join(', ');
      out += `\nsource tables: ${src || '(none recorded)'}\nSQL:\n${sqlText(st.body)}\n`;
    }
    out += d
      ? `\nreads_from: ${d.parents.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\nread_by: ${d.children.map((x) => nameOf(x.id, m)).join(', ') || '(none)'}\non_dashboards: ${d.dashboards.map((x) => nameOf(x, m)).join(', ') || '(none)'}\n`
        + 'Note: Zoho Analytics only knows what its own views read from each other - a shared link, a scheduled export or an API consumer is invisible to it.'
      : '\nlineage: not pulled';
    return out;
  }
  if (name === 'get_structure') return aiStructureText(v);
  if (name === 'get_sql') {
    const st = await sqlReadState(v.id, op);
    if (st.kind === 'not-query') return `${v.name} is a ${v.type}, not a query table - it has no SQL.`;
    if (st.kind === 'unread') return `${v.name} IS a query table, but its SQL could not be read (${st.error}). Retry failed / Pull all fetches it - do not conclude anything from its absence.`;
    const q = st.query;
    const src = Object.entries(q.sources || {}).map(([, sdef]) => `${sdef.name} (${sdef.columns.length} columns involved)`).join(', ');
    return `${v.name}\nsource tables: ${src || '(none recorded)'}\n\n${sqlText(st.body)}`;
  }
  if (name === 'search_sql') {
    // With the matching line beside each name the model can usually answer without opening the
    // query at all - a bare list of names made every hit cost another call.
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = []; let searched = 0, unread = 0;
    const qts = views.filter((x) => x.type === 'QueryTable');
    for (const vv of qts) {
      const st = await sqlReadState(vv.id, op);
      if (st.kind === 'unread') { unread++; continue; }
      searched++;
      const body = st.body;
      if (!body || !body.toLowerCase().includes(q)) continue;
      const line = body.split('\n').find((l) => l.toLowerCase().includes(q)) || '';
      hits.push(`${vv.name}\n    ${line.trim().slice(0, 160)}`);
    }
    // Coverage travels with the answer: «no matches» over 47 of 50 queries is a different fact from
    // «no matches» over all of them, and only the search knows which it was.
    const cover = unread ? ` Searched ${searched}/${qts.length} query tables - ${unread} SQL source(s) were unreadable, so absence is not exhaustive.` : '';
    return hits.length ? `${hits.length} query table(s) contain "${input.query}":${cover}\n` + aiCap(hits, hits.length, MSG.narrow, 60)
                       : `(no matches)${cover}`;
  }
  if (name === 'search_columns') {
    const q = String(input.query || '').toLowerCase(); if (!q) return '(empty query)';
    const hits = [];
    for (const [id, t] of Object.entries(schema)) {
      const cols = t.columns.filter((c) => c.name.toLowerCase().includes(q));
      if (cols.length) hits.push(`${t.name} [${t.kind}]: ` + cols.map((c) => `${c.name} (${c.type})`).join(', '));
    }
    return hits.length ? `${hits.length} table(s) have a matching column:\n` + aiCap(hits, hits.length, MSG.narrow) : '(no matches)' + aiMirrorShort();
  }
  if (name === 'get_relations') {
    const list = v ? relationsOf(v.id) : relations;
    if (!list.length) return (v ? `${v.name} takes part in no relation.` : 'No relations in this workspace.') + aiMirrorShort();
    return `${list.length} relation(s):\n` + aiCap(list.map((r) => `${r.sourceName} → ${r.targetName}   ${r.relation}`), list.length, 'Pass a table name to see only its relations.');
  }
  if (name === 'who_uses') {
    const d = deps && deps[v.id];
    if (!d) return `No lineage for ${v.name} - it was not pulled.`;
    return `${v.name} is read by ${d.children.length} view(s) and appears on ${d.dashboards.length} dashboard(s).\n`
      + (d.children.map((x) => `- ${nameOf(x.id, m)} (level ${x.level})`).join('\n') || '(nothing reads from it)')
      + `\nNote: Zoho Analytics only knows what its own views read from each other. A shared link, a scheduled export, an embedded report or an API consumer is invisible to it.`;
  }
  if (name === 'orphans') {
    if (!deps) return 'Lineage was not pulled, so this cannot be answered.';
    const o = views.filter(isOrphanCandidate);
    const byType = new Map();
    for (const x of o) byType.set(x.type, (byType.get(x.type) || 0) + 1);
    return `${o.length} candidate(s) that nothing in this workspace depends on - candidates, not a verdict.\n`
      + 'By type: ' + [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') + '\n'
      + aiCap(o.map((x) => `- ${x.name} [${x.type}]`), o.length, 'Use list_views with a type to see the rest.')
      + aiMirrorShort('any')
      + '\nAnalytics only knows what its own views read from each other: a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.';
  }
  return 'Unknown tool: ' + name;
}

// Transport and rendering, ported verbatim in behaviour from the CRM panel: streaming Anthropic
// agent loop, single-shot OpenAI with the max_tokens → max_completion_tokens retry on that specific
// 400 (newer models reject the older field). Only the two engines the manifest grants host access to
// are supported, because those are the two that are tested.
function aiMarkdown(src) {
  const codes = [];
  let t = esc(src == null ? '' : src);
  t = t.replace(/\u0060\u0060\u0060(\w*)\n?([\s\S]*?)\u0060\u0060\u0060/g, (mm, lang, code) => { codes.push('<pre class="aicode">' + code.replace(/\n+$/, '') + '</pre>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\u0060([^\u0060\n]+)\u0060/g, (mm, c) => { codes.push('<code>' + c + '</code>'); return '\uE000' + (codes.length - 1) + '\uE001'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/^#{1,6}\s+(.*)$/gm, '<strong>$1</strong>');
  t = t.replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
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
  t = t.replace(/\uE000(\d+)\uE001/g, (mm, i) => codes[+i]);
  return t;
}
function aiToolArg(input) { try { const t = JSON.stringify(input || {}); return t.length > 60 ? t.slice(0, 57) + '…' : t; } catch (_) { return ''; } }
function aiToolEvent(name, input) { aiMessages.push({ role: 'tool', content: `🔧 ${name}(${aiToolArg(input)})` }); aiRenderMessages(); }

let AI_MAX_TOKENS = AI_MAX_TOKENS_DEFAULT;   // set from the saved config before each run
async function aiStreamAnthropic(a, msgs, system, tools, onText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: a.model, max_tokens: AI_MAX_TOKENS, system, tools, messages: msgs, stream: true }) });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${aiTrunc(await res.text(), 300)}`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const blocks = []; let stop_reason = null;
  const handle = (evt, data) => {
    // A block is text, a tool call, or **thinking** - and the third was being read as the first.
    // A model that reasons before answering opens a `thinking` block, and this mapped every
    // non-tool block to `{ type: 'text', text: '' }`; its `thinking_delta`s then matched no
    // branch below, so the block stayed empty, was dropped as an empty text block, and the
    // panel said «(empty response)». Measured from a HAR of a real question: one block, type
    // `thinking`, deltas `thinking_delta` and `signature_delta`, no text and no tool_use.
    //
    // Kept rather than ignored, because what it costs is the thing to report: the whole answer
    // budget can go into it, and a reader who is told «empty» learns nothing about that.
    if (evt === 'content_block_start') {
      const t = data.content_block.type;
      blocks[data.index] = t === 'tool_use'
        ? { type: 'tool_use', id: data.content_block.id, name: data.content_block.name, _json: '' }
        : t === 'thinking' || t === 'redacted_thinking' ? { type: 'thinking' }
        : { type: 'text', text: '' };
    }
    else if (evt === 'content_block_delta') { const b = blocks[data.index]; if (!b || b.type === 'thinking') return; if (data.delta.type === 'text_delta') { b.text += data.delta.text; onText && onText(data.delta.text); } else if (data.delta.type === 'input_json_delta') { b._json += data.delta.partial_json || ''; } }
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
  // Thinking is not shown and is not sent back, and the second half is measured rather than
  // assumed. The recorded conversation shows two assistant turns of `tool_use` with no
  // thinking block in what we sent, five messages deep, answered 200 - so the API accepts a
  // turn whose reasoning was dropped, at least while `thinking` is not requested, and this
  // panel never requests it.
  //
  // **What is not established**: Anthropic documents that with extended thinking *enabled*
  // over tool use the thinking blocks have to be passed back. We do not enable it and get
  // one anyway. Sending them back untested could break the thing that currently works, so it
  // is left as it is and written down here instead of being guessed at - the boundary this
  // rests on, in our own voice rather than found later in a stack trace.
  //
  // What it does carry out is *whether* there was any, because that is what explains a turn
  // that produced nothing else.
  const thought = blocks.some((b) => b && b.type === 'thinking');
  const content = blocks.filter(Boolean).filter((b) => b.type !== 'thinking').map((b) => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'text', text: b.text }).filter((b) => b.type !== 'text' || (b.text && b.text.trim() !== ''));
  return { content, stop_reason, thought };
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
    const { content, stop_reason, thought } = await aiStreamAnthropic(a, msgs, system, tools, onText);
    if (!current()) return;
    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (stop_reason !== 'tool_use' || !toolUses.length) {
      // **A half answer is not an answer, and it looked exactly like one.** The explanation below
      // only fires when *nothing* was streamed; when the model starts writing and then reaches the
      // budget, the reader is left with a paragraph that stops mid-sentence and no way to tell that
      // from a model that had finished. Written the same way in the twin.
      if (bubble && stop_reason === 'max_tokens') {
        bubble.content += `\n\n---\n*Cut off here: the model reached its answer budget of ${AI_MAX_TOKENS} tokens.`
          + ' Ask a narrower question, or raise **Answer budget** in Settings.*';
        aiRenderMessages();
      }
      if (!bubble) {
        const txt = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        // «(empty response)» was what a turn that hit its answer budget looked like, and it names
        // neither the cause nor the remedy - on a call the reader has paid for. Measured from a
        // HAR: `stop_reason: max_tokens`, 4,096 output tokens, every one of them thinking, and
        // not one character of answer. The input was 40,120 tokens, so the index sent with each
        // message was nowhere near the problem, which is the first thing anyone would suspect.
        aiMessages.push({ role: 'assistant', content: txt || (stop_reason === 'max_tokens'
          ? `The model reached its answer budget of ${AI_MAX_TOKENS} tokens`
            + (thought ? ' while still reasoning, and never began the answer' : ' before finishing')
            + '. Nothing was lost and nothing was written. Ask again - a narrower question costs'
            + ' less of that budget - or raise **Answer budget** in Settings.'
          : '(the model returned nothing at all - no answer, no reasoning and no tool call)') });
        aiRenderMessages();
      }
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
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  async function post(limitField) {
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      // **The budget the reader set, not a number written here.** Settings says «Tokens one answer
      // may cost» and names that box in the message the panel prints when a reply is cut - and this
      // engine ignored it and sent 4096, so raising it changed nothing and the explanation sent the
      // reader to change model for an output ceiling. The other engine has read it since it shipped.
      body: JSON.stringify({ model: o.model, messages: msgs, [limitField]: AI_MAX_TOKENS }),
    });
  }
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
  // The same cut, the other engine: text *and* a length stop is a truncated answer, and it used to
  // be returned as if it were whole.
  if (txt && c && c.finish_reason === 'length')
    return txt + '\n\n---\n*Cut off here: the model reached its output limit. Ask a narrower question.*';
  return txt;
}

function aiRenderMessages() {
  const box = $('aimsgs');
  // **Absent, not present-and-pointless, when there is nothing to clear.** Every other control here
  // disappears rather than sitting there greyed: the retry button, the per-mode rows. This one stayed
  // on an empty conversation, offering to remove nothing. Reported by the author, who had written the
  // convention it was breaking.
  $('aiclear').style.display = aiMessages.length ? '' : 'none';

  if (!aiMessages.length && !aiBusy) { box.innerHTML = '<div class="aimsg assistant"><div class="aitext">Ask me anything about this workspace - I can read structures, follow foreign keys, open the SQL of a query table, search columns, and say what depends on what.</div></div>'; return; }
  box.innerHTML = aiMessages.map((m) => m.role === 'tool' ? `<div class="aitool">${esc(m.content)}</div>` : `<div class="aimsg ${m.role}"><div class="airole">${m.role === 'user' ? 'You' : 'AI'}</div><div class="aitext">${m.role === 'assistant' ? aiMarkdown(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div></div>`).join('')
    + (aiBusy ? '<div class="aiwait"><i></i><i></i><i></i> thinking…</div>' : '');
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
  if (!(await aiEnsureFiles())) { status('Folder access needs re-granting - press \u21bb Refresh, then ask again.', 'warn'); return; }
  if (!current()) return;
  if (!aiActiveReady(cfg)) { openSettings('#ai'); status('Set the model and API key in Settings (just opened), then try again.', 'warn'); return; }
  const inp = $('aiinput'); const text = inp.value.trim(); if (!text) return;
  inp.value = ''; aiMessages.push({ role: 'user', content: text });
  aiBusy = true; $('aisend').disabled = true; aiRenderMessages(); status('AI thinking…', 'busy');
  // `finally`, not the last line. Everything from here on can exit through `if (!current())` - the
  // workspace was left, or the conversation was cleared - and each of those exits used to leave
  // `aiBusy` true and the Send button disabled *for the life of the panel*, with the «thinking…»
  // dots still on screen. Every later question then returned at the first line.
  //
  // It was reachable without changing workspace at all: `wsGen` is bumped by every selection,
  // including re-selecting the one already open (the ✎ rename, ↻ Refresh after a lapsed permission,
  // the capture-phase re-grant click), while `dropWorkspaceState` - the only other place that clears
  // this flag - runs only when the workspace actually differs. The flag is owned by the function
  // that sets it, so it is released here whatever happens. Same fix in the CRM twin.
  try {
    const apiMessages = aiMessages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim() !== '').map((m) => ({ role: m.role, content: m.content }));
    const withTools = cfg.active === 'anthropic';
    const system = await aiSystemPrompt(withTools, cfg.seedCap, op);
    if (!current()) return;
    // The workspace index sent to the model is capped. If it was cut, say so once - do not let the
    // user assume the model saw everything. Claude can still look things up; OpenAI cannot.
    if (aiSeedTruncated && !aiSeedWarned) {
      aiSeedWarned = true;
      const what = aiSeedOmitted.length ? aiSeedOmitted.join(' and ') : 'part of the index';
      aiMessages.push({ role: 'tool', content: `ℹ️ Large workspace: ${what} could not fit in the index sent with each message. `
        + (withTools ? 'Claude can still find them by name with its tools - the tables are always included in full.' : 'OpenAI answers in one pass and cannot look them up, so ask about specific views by name.') });
      aiRenderMessages();
    }
    // The reader's ceiling reaches the request here, once, before the loop that spends it.
    AI_MAX_TOKENS = cfg.maxTokens || AI_MAX_TOKENS_DEFAULT;
    if (withTools) await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20, current, op);
    else { const reply = await aiCall(cfg, apiMessages, system); if (!current()) return; aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    if (!current()) return;
    status('', '');
  } catch (e) { if (!current()) return; aiMessages.push({ role: 'assistant', content: MSG.errPrefix + friendlyError(e) }); status('AI error', 'warn'); }
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
  if (cfg.active === 'anthropic') { b.textContent = 'Claude · agent'; b.className = 'agent'; note.className = 'ainote'; }
  else {
    b.textContent = 'OpenAI · single-shot'; b.className = 'single';
    $('ainotetxt').innerHTML = 'OpenAI answers in <b>one pass</b>: it sees the workspace index plus the view you have open, '
      + 'and cannot go and read other structures by itself - so it will ask you for what it is missing. '
      + 'Switch to Claude in Settings for an agent that explores the whole workspace on its own.';
    note.className = 'ainote show';
  }
}
// The index is sent with *every* message, so its size is what each question costs before you have
// asked anything. Showing it is the only way the setting that caps it can be a real choice rather
// than a number in a form: build it once, measure, and say so.
async function aiContextLabel() {
  const op = beginWorkspaceOp();
  const el = $('aictx'); if (!el) return;
  const v = selectedId ? viewById().get(selectedId) : null;
  const focus = v ? `Focus: ${v.name}` : 'No view focused - open one to give structure-level context';
  let cost = '';
  try {
    const cfg = await aiGetCfg();
    await aiBuildSeed(cfg.seedCap, op);
    if (!op.current()) return;
    // Counts the product primer too. A figure reporting only the index would understate what is
    // actually billed, and this line exists precisely so the knob and its consequence sit in the
    // same sentence.
    const total = aiSeedSize + productHelp().length;
    const tok = Math.round(total / 4);
    cost = ` · sent with every message: ${(total / 1000).toFixed(0)}k characters, ~${tok.toLocaleString()} tokens`
      + (aiSeedOmitted.length ? ` · ${aiSeedOmitted.join(' and ')} left out` : '');
  } catch (_) {}
  el.textContent = focus + cost;
}
function toggleAI() {
  if ($('aiview').classList.contains('show')) { closeAI(); return; }
  if (!views.length) return;
  closeHealth(); closeOverview();   // one panel at a time
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open');
  aiEngineChrome(); aiRenderMessages();
  aiEnsureFiles().then(aiContextLabel);   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it - switching workspace does it too, because the old thread was about another workspace.')) return; dropWorkspaceState(); }
