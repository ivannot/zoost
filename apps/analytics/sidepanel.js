/*
 * sidepanel.js - Zoost for Zoho Analytics.
 *
 * Mirrors a Zoho Analytics workspace into plain local files, then lets you navigate what came back:
 * every view with its type and folder, the columns of every table and query table, the SQL that
 * builds each query table, and the lineage between them.
 *
 * Read-only towards Zoho, always. The only thing it writes is your own working folder.
 *
 * Two rules carried over from the CRM panel, for the same reasons:
 *  - The workspace is whichever one the active tab is in. Leave that tab, or move to a different
 *    workspace, and every Zoho-bound action goes dead rather than acting on the wrong one.
 *  - A workspace's identity is the id inside .zoost.json, never the folder name. Renaming the
 *    folder, or renaming the workspace in Zoho, must not orphan what is on disk.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Attribute-safe: `&`, `<`, `>`, and **both** quote characters. esc() does not escape quotes, and a
// quote inside an attribute closes it early. Escaping both styles means a reader never has to work
// out which one an attribute used - the same definition as the CRM panel and both graph windows.
const escA = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Already through `escHtml`, so `& < >` are encoded; what is left is the delimiter that decides
// where an attribute ends. `escA` cannot be used here - it encodes `&` too, and this value has been
// encoded once already, so the query string of every link the assistant writes would come out as
// `&amp;amp;`. Named rather than inline, because `tools/htmlcheck.py` reads the name to know an
// attribute is safe, and a check that cannot see the escaping is a check that will be argued with.
// The two delimiters written as escapes, not as themselves: a regex literal containing a quote is
// the trap this repository already records against `sliceConst`, and it bites every scanner that
// reads JavaScript without parsing it - the duplicate-message check and the slicer both lost their
// place on the first version of this line.
const escQ = (s) => String(s).replace(/[\u0022\u0027]/g, (c) => (c === '\u0022' ? '&quot;' : '&#39;'));

const PRODUCT_NAME = chrome.runtime.getManifest().name;   // single source of truth: rename in manifest.json only
// Built from the manifest: the hosts this extension is allowed to read are exactly the hosts it
// should recognise, and a second list is a list that goes out of date. Zoho has more data centres
// than the six that were written here - zoho.sa, zoho.uk and zoho.ae, each with a current
// certificate and a live accounts service.
// The suite shells are in it too. Inside Zoho One - and Zoho CRM Plus the same way - a workspace is
// an ordinary Analytics page in a frame of its own and the *tab* is the shell, so a panel that only
// recognises `analytics.*` refuses the tab before it can look inside it. The shells declare no
// content script: they are named so the tab is recognised and its frames can be enumerated, and
// everything after that happens in the Analytics document, as it does on a plain Analytics tab.
const HOST_RE = new RegExp('^(' + (chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/(analytics|one|crmplus)\./.test(h))
  .map((h) => h.replace(/\/\*$/, '').replace(/\./g, '\\.')).join('|') + ')\\/');
// The Analytics application's own origin, which is where the bridge lives and the only thing this
// panel ever speaks to. `HOST_RE` says «this tab is Zoho»; this says «this document is the app».
const APP_HOST_RE = /^https:\/\/analytics\.zoho/;

const PULL_TITLE = 'Pull all - views, structure, relations, SQL and lineage';
const APP_DIR = 'analytics';                  // this app's subfolder inside the working folder
const APP_DIRS = ['crm', 'analytics'];        // known product folders - not "foreign" content
const CFG = '.zoost.json';
// **The blast radius, said once.** It was written three times in the CRM and nowhere at all in
// Analytics, and the three did not agree: one said the permission lasts «permanently», which is
// not true of a stored handle - Chrome drops it between sessions, which is why both panels have a
// re-grant path. A warning that overstates is read once and discounted afterwards. Same sentence
// in both products and on the settings page, held by a test that strips the markup and compares.
const BLAST_RADIUS = 'Zoost will hold read and write access to everything inside that folder, for as long '
  + 'as the browser keeps the permission. A dedicated folder is strongly recommended - not your home or '
  + 'Documents.';

// The pull's own commit marker: `writing` from the first byte of a full pull to its last, `complete`
// after. A mirror mid-write is five files from two moments; the loader refuses it rather than
// presenting it as one. Partial writers (a single re-read, a retry) do not touch it - they replace
// one file, which is atomic enough on its own.
const PULL_STATE = '.pull-state.json';
// The data centre to fall back on when the panel knows neither a workspace nor a tab. A
// display-only copy of a setting: read into a URL, never written from here.
let zohoDc = 'zoho.com';
// Pull schema version: bump it when the pull starts capturing something it did not before.
//
// **It has to be read somewhere, or bumping it does nothing.** It was written into every config
// and by nothing else, so a mirror from an older schema would have been published as current with
// the new fields quietly missing - the version was decoration. `mirrorIsOlderThanSchema()` is what
// reads it; what it does is *say so*, not refuse, because a mirror written by an older Zoost is
// still every fact it captured and the reader decides whether that is enough. The twin marks the
// rows it can re-fetch and re-fetches them; this mirror has no per-row granularity to mark.
const PULL_SV = 1;

// Every sentence this panel says in more than one place, plus the one it shares with the CRM panel.
// A message written out twice is two messages the moment somebody edits one of them - so a literal
// that appears once stays where it is used, and `folder` is the declared exception: requirePerm()
// exists in both apps and must throw the *same* sentence, or the same lapsed permission arrives
// worded one way in Zoost CRM and another in Zoost Analytics. ↻ Refresh is the control that re-asks.
// tests/panel.test.mjs enforces the rule in the other direction, over every shipped script.
const MSG = {
  mismatchRefused: 'The active tab is a different workspace from this one - nothing here reads Zoho Analytics until they match.',
  folder: 'Folder access needs re-granting - click ↻ Refresh.',
  narrow: 'Use a longer substring to narrow.',
  narrowNav: 'No step here matches that. Clear the box to see the whole chain.',
  copyFailed: 'Could not copy: ',
  navGone: 'That step is not in this workspace any more.',
  errPrefix: 'Error: ',
};

// Identity and legal text, worded as in the CRM panel - the two are one product to the reader.
const PRODUCT_URL = 'https://zoost.it';

// Anything that is not Zoho opens in its own window, never a tab.
//
// chrome.tabs.create *activates* the new tab, so the panel suddenly finds itself looking at a
// non-Zoho page: the environment guard fires, the interface empties and the mismatch overlay
// appears. That behaviour is right when it means what it says, and here it meant nothing at all -
// the user clicked Help and the workbench looked like it had lost its place.
//
// Derived rather than listed: every link in the panel goes through here, and the only ones let
// through to a tab are Zoho's own, which are meant to land in the Zoho tab. A link added tomorrow
// is covered without anyone remembering.
// Zoho's own hosts, with or without a subdomain, and nothing that merely contains the word:
// `notzoho.com` and `evil.com/zoho.x` are not Zoho, and treating them as such would send them to
// the Zoho tab where the guard would then complain about a mismatch it did not cause.
// Zoho's own pages belong in the Zoho tab. It stays a rule about the domain rather than a list of
// granted hosts - a link to a Zoho page we do not read is still a Zoho page - and it had one
// blind spot: the Canadian data centre is `zohocloud.ca`, which is not literally «zoho.something»,
// so those links were opening in a window of their own.
function isZohoUrl(u) {
  return /^https?:\/\/(?:[^./?#]+\.)*(?:zoho\.com|zoho\.eu|zoho\.in|zoho\.com\.au|zoho\.jp|zohocloud\.ca|zoho\.sa|zoho\.uk|zoho\.ae)(?::\d+)?(?:[/?#]|$)/i.test(String(u || ''));
}

function openExternal(url) {
  try {
    chrome.tabs.query({ url }, (found) => {
      const t = found && found[0];
      // Best-effort and said so: focusing or opening a window is a courtesy, the outer catch
      // already falls back, and a rejection here costs the reader nothing. Declared with a
      // `.catch()` because an unhandled rejection is an omission and a written one is a
      // decision - the `try` around this could never have caught it, being a callback.
      if (t) { void chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        void chrome.tabs.update(t.id, { active: true }).catch(() => {}); return; }
      void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
    });
  } catch (_) {
    void chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }).catch(() => {});
  }
}
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href^="http"]');
  if (!a) return;
  if (isZohoUrl(a.href)) return;   // Zoho's own pages belong in the Zoho tab
  e.preventDefault();
  openExternal(a.href);
});

// Settings live in one window, and only ever one.
//
// `openOptionsPage()` opens a tab, and only de-duplicates within the *current* browser window -
// while the side panel is per window. Two browser windows, two settings tabs; over a working day,
// ten. That is not a tidiness problem: every one of them is a form holding a snapshot of the
// settings from the moment it opened, and saving an old one silently overwrites a newer one with
// stale values. It is the same trap as having the same Deluge function open in two tabs and being
// invited to "save your work" by the older of them.
//
// So: find any existing settings tab across all windows, focus it, and open a dedicated popup
// window only if there is none. Existing duplicates are focused, never closed - one of them may
// hold edits, and discarding those to enforce uniqueness would be committing the very mistake this
// prevents. They disappear as they are closed.
//
// Uniqueness by construction is still not enough on its own, which is why options.js also refuses to
// save over a value that changed underneath it. A window can be closed and reopened, the extension
// reloaded, and the panel itself writes some of these keys.
// `where` is a fragment - '#ai' from the assistant - so a reader sent to change one thing lands on
// it instead of at the top of a page about eight. An already-open settings window is focused *and*
// moved, because otherwise the second ask does nothing visible and reads as a broken button.
async function openSettings(where) {
  const url = chrome.runtime.getURL('options.html') + (where || '');
  try {
    const open = await chrome.tabs.query({ url: chrome.runtime.getURL('options.html') });
    if (open && open.length) {
      await chrome.windows.update(open[0].windowId, { focused: true });
      await chrome.tabs.update(open[0].id, { active: true, url });
      return;
    }
    await chrome.windows.create({ url, type: 'popup', width: 880, height: 900 });
  } catch (_) {
    chrome.runtime.openOptionsPage();   // whatever went wrong, the settings must still be reachable
  }
}

// Each app points at *its own* pages. Analytics shipped with the Help link hard-coded to the CRM
// guide, which is the kind of thing that only ever gets found by a user - so both are named here,
// once, and every surface derives from them instead of writing a path inline.
const PAGE_URL = PRODUCT_URL + '/analytics.html';
const DOCS_URL = PRODUCT_URL + '/docs-analytics.html';
const STORE_URL = 'https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge';
const CONTACT_EMAIL = 'ivan@zoost.it';
const REPO_URL = 'https://github.com/ivannot/zoost';
const SPONSOR_URL = 'https://github.com/sponsors/ivannot';
const KOFI_URL = 'https://ko-fi.com/ivannot';
const PRODUCT_AUTHOR = 'Ivan Notaristefano';
const PRODUCT_LICENSE = 'Apache License 2.0';
const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';
const LEGAL_DISCLAIMER = 'Independent, unofficial tool. Not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. '
  + '"Zoho" and "Zoho Analytics" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility. '
  + 'Licensed under the Apache License 2.0 and provided AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. '
  + 'The author accepts no liability for any loss, damage or data issue arising from its use, and is under no obligation to provide support or maintenance. '
  + 'Deciding what may be extracted from Zoho Analytics, and where it may be sent, is the sole responsibility of the user and of the organisation whose data it is.';

// ---------- state ----------
let root = null;            // the working folder handle
let rootGranted = false;
let dir = null;             // the active workspace folder handle
let bound = null;           // { workspace, name, origin } of the active workspace, from its .zoost.json
let ctx = null;             // { origin, workspace, view } of the active tab
let busy = false;
let pullDepth = 0, pullBusy = false;

let wsList = [];            // workspaces found on disk, cached like the CRM panel's
let views = [], folders = [], schema = {}, relations = [], sqls = {}, deps = null, pullFailed = [];
// When the views were last read, out of `views.json` where the pull wrote it. The report's
// freshness line asked `bound.lastPull` and `deps.pulledAt`, and neither exists: `bound` is built
// from five fields of the config and `deps` is the id-to-dependency map. So every export said
// «never read» about a workspace pulled a minute earlier, which is the half-truth this project
// refuses - and the date was on disk the whole time.
let viewsPulledAt = null;
const ORPHANS = '__orphans__';
let typeFilter = null, sortKey = 'name', sortDir = 1, selectedId = null, detailTab = 'cols';
let detailLoad = 0;
const detailCurrent = (mine, op) => mine === detailLoad && op.current();

// ---------- status ----------
function status(text, kind) { noteStep(text); $('statustext').textContent = text; $('status').className = kind || ''; showEmergency(false); }



// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
function showEmergency(on) { for (const id of ['emerg', 'repopen', 'repdismiss']) { const e = $(id); if (e) e.classList.toggle('on', !!on); } }

// ---------- filesystem ----------
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
async function hasPerm(h) {
  return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
}
// Chrome drops the folder permission between sessions, so anything that is about to write has to
// ask first - under a real click, which every caller of this is. Without it the first write throws
// `NotAllowedError: The request is not allowed by the user agent…`, which names neither the folder
// nor the remedy and reads as the extension being broken. The CRM panel guards all fifteen of its
// mirror-writing entry points; this one guarded two of five, and pullAll, pullOne and retryFailed
// wrote straight to disk. Same wording as the twin, so one message covers both products.
async function requirePerm(h) { if (!(await ensurePerm(h))) throw new Error(MSG.folder); }
// The folders, remembered. Every read and every write resolved `functions/<namespace>/` from the
// root again - two calls to the browser's file system before the one that does the work - so half of
// what a pull and a load spend is asking for the same directory over and over. Measured: writing a
// function cost 8 calls, of which 4 were this.
//
// Handles are per working folder, so the cache is dropped whenever that changes; a stale handle is
// worse than a slow one, and this is the kind of cache that has to be given up eagerly rather than
// checked. `removeEntry` drops it too, since a folder that has just been deleted must not be handed
// back by us.
// Keyed on the root, not one map for whichever folder is current. It walked from `dir`, awaited each
// step, and then wrote what it found into the *global* cache - so a resolution that started in one
// workspace and finished after a switch filled the new workspace's cache with the old one's handles,
// and the next lookup there answered without ever asking that folder. Reproduced in both panels: a
// path resolved in B came back holding A's handle with zero calls to B.
//
// A cache per root cannot say the wrong thing about the other one: the entry goes where it was read
// from. Handles still have to be given up eagerly rather than checked - a stale one is worse than a
// slow one - so a switch drops everything and `removeEntry` drops everything, since a folder that
// has just been deleted must not be handed back by us.
let _dirCaches = new WeakMap();
const forgetDirs = (root) => { if (root) _dirCaches.delete(root); else _dirCaches = new WeakMap(); };
async function dirFor(parts, create, root = dir) {
  if (!root) throw new Error('No workspace folder is open.');
  let cache = _dirCaches.get(root);
  if (!cache) _dirCaches.set(root, (cache = new Map()));
  const key = parts.join('/');
  // The cache answers for writes too: a folder that has been created once exists, and asking the
  // browser to create it again is the call this exists to avoid. Skipping the cache when `create`
  // was set left a pull paying full price for every file it wrote - half of the eight calls each.
  if (cache.has(key)) return cache.get(key);
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, create ? { create: true } : undefined);
  cache.set(key, d);
  return d;
}

/** What a write means for what is still held in memory from that file. The CRM panel's `noteWrite`,
 *  with one entry, because this product has one cache of file contents.
 *
 *  `in: SQL` reads every query once and keeps it for the session, and it was dropped in
 *  `loadFromDisk()` alone - which a pull passes through and a *re-read* does not. So «Re-read this
 *  view» and «Retry the failures» replaced the SQL in memory, wrote it out, and left the search
 *  matching the query as it used to be: the mirror right and the panel confidently wrong about it,
 *  the same defect the CRM had in `syncOne`. Deriving it from the write means the next path that
 *  writes a query inherits this without knowing it exists. */
function noteWrite(rel) {
  if (rel.startsWith('sql/') && rel.endsWith('.sql')) {
    sqlCache = null;
    // A successful rewrite may have repaired any file that previously refused to open. The path
    // does not carry the view id, so discard the small negative cache whole rather than risk
    // leaving one repaired query described as unreadable.
    sqlDiskUnread.clear();
  }
}
// The workspace an operation belongs to, taken once and carried - not read out of a global after
// every await. A pull reads from Zoho, waits, and then writes: `dir` at that moment is whatever the
// panel is showing *now*, so a switch part-way through wrote one workspace's views, schema and SQL
// into another workspace's folder - and put its ids into the other one's memory. Measured.
//
// The root is a parameter of the I/O and the refusal lives in the one place every write passes
// through. `current()` is what a caller asks before spending effort or touching what is in memory;
// the writer refuses regardless, which is what makes the class impossible rather than unlikely.
const WS_MOVED = 'The workspace changed while this was running - nothing further was written to it.';
function beginWorkspaceOp() {
  const gen = wsGen, root = dir;
  const current = () => gen === wsGen && root === dir;
  // See the CRM twin: a handle is not an identity through time. Leave a workspace and come back and
  // the same object is current again, so an operation from before the round trip passed a check that
  // compares handles while `current()` said false. Asked on both sides of the await.
  const guard = () => { if (!current()) throw new Error(WS_MOVED); };
  async function through(fn) { guard(); const v = await fn(); guard(); return v; }
  return {
    root, gen, current,
    read: (p) => through(() => readFileAt(root, p)),
    write: (p, body) => through(() => writeFileAt(root, p, body)),
    remove: (p) => through(() => removeFileAt(root, p)),
    // Progress belongs to a workspace as much as a write does. Reported on the CRM side: a pull kept
    // counting into the panel after the user had opened another workspace, so the work looked like it
    // was happening there. Here the counting arrives as a message from the bridge, which is the same
    // thing one layer out. It says nothing once it is not there.
    say: (msg, kind) => { if (current()) status(msg, kind); },
  };
}
async function writeFileAt(root, rel, content) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), true, root);
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
  noteWrite(rel);
}
async function readFileAt(root, rel) {
  const parts = rel.split('/');
  const d = await dirFor(parts.slice(0, -1), false, root);
  const fh = await d.getFileHandle(parts[parts.length - 1]);
  return (await fh.getFile()).text();
}
// The shorthands every render path uses: they read and write the workspace on screen, which is the
// one they mean. A path that survives an await must take an op instead.
async function removeFileAt(root, path) {
  if (root !== dir) throw new Error(WS_MOVED);
  const parts = path.split('/'); const name = parts.pop();
  let d = root; for (const q of parts) d = await d.getDirectoryHandle(q);
  await d.removeEntry(name); noteWrite(path);
}
const writeFile = (rel, content) => writeFileAt(dir, rel, content);
const readFile = (rel) => readFileAt(dir, rel);
// Every file in a workspace, path first. The twin of the CRM panel's, and it was *called* here
// before it existed: `pruneSql` walks the tree to find the .sql files the new index no longer names,
// and the line was written from the CRM side where the helper is. Nothing said so - `node --check`
// is happy with a free variable, no test runs a pull, and the ReferenceError landed inside the one
// try block that marks the mirror incomplete, so a pull that had written every byte correctly ended
// as «the last pull was interrupted mid-write» and the repair ran into the same wall.
async function* walk(d, prefix = '') {
  for await (const [name, h] of d.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') yield* walk(h, prefix + name + '/'); else yield prefix + name;
  }
}
// «Not there» and «could not be read» are different facts, and this returned the same fallback for
// both - so a workspace whose files were all on disk was announced as never pulled, and the reader
// was sent to press Pull all over a folder that had simply gone unreadable. Reported. The file three
// screens down carries the same lesson about empty vs unreadable *inside* a file; this is the same
// mistake one level up, about the file itself.
//
// The fallback stays, because most callers genuinely want «use this when there is nothing». What is
// added is that a failure which is not «no such file» leaves a trace, so whoever asks can say which
// of the two happened.
async function readJson(rel, fallback, op, onFailure) {
  try { return JSON.parse(await (op ? op.read(rel) : readFile(rel))); } catch (e) {
    // A late read belongs to the workspace it started in. In particular it must not revoke the
    // permission verdict, or leave an unreadable-file reason, in the workspace that replaced it.
    if (op && !op.current()) return fallback;
    // `NotAllowedError` is Chrome saying the folder permission has lapsed, and it is proof that the
    // cached verdict in `rootGranted` is wrong. Leaving that verdict alone is what made the state
    // circular: the panel only re-requests permission while it believes it has none, so believing it
    // has some meant no click - Refresh included - ever asked for it back. Reported exactly that way:
    // «the message is clearer but pressing Refresh changes nothing».
    if (e && e.name === 'NotAllowedError') rootGranted = false;
    // Losing permission is also a failed read. The global verdict and the caller-local reason are
    // two different effects; making them an either/or let a partial SQL refresh replace an index
    // it was not allowed to read with the empty fallback.
    if (e && e.name !== 'NotFoundError' && onFailure) onFailure({ rel, name: (e && e.name) || 'Error' });
    return fallback;
  }
}
// What the last load off disk ran into, and the only thing the empty state is allowed to speak about:
// a stray failure from some unrelated read must not turn into a sentence about this workspace.
let diskUnreadable = null;
let diskUnreadableAll = [];   // all of them, because the sentence names what is missing
// Set by the one branch of `loadFromDisk` that refuses a mirror outright, and cleared by every other
// path through it, so the empty state can name that refusal instead of falling through to «nothing
// pulled yet» - which is what a reader was told about a folder full of files.
let pullInterrupted = false;
const writeJson = (rel, o, op) => (op ? op.write(rel, JSON.stringify(o, null, 2)) : writeFile(rel, JSON.stringify(o, null, 2)));
// Merge rather than replace. `.zoost.json` holds more than the binding - the workspace's own name
// lives there too - and a whole-object write from any one writer silently drops what the others put
// in it. The CRM learnt this twice; this side inherits the lesson rather than the bug.
// The op reaches here because `.zoost.json` is the file that says which workspace this folder
// mirrors. Optional, so the render paths that mean the folder on screen are unchanged.
async function patchCfg(o, op) {
  return writeJson(CFG, Object.assign({}, await readJson(CFG, {}, op), o), op);
}
// Filenames are derived from Zoho's names, so anything a filesystem dislikes has to go. The id is
// appended because two views in different folders may legitimately share a name.
const sanitize = (s) => String(s).replace(/[^\w.\-]/g, '_');
const stemOf = (name, id) => (String(name || 'unnamed').replace(/[^\w.\- ]/g, '_').trim().slice(0, 80) || 'unnamed') + '-' + id;

async function appRoot(create) {
  if (!root) return null;
  try { return await root.getDirectoryHandle(APP_DIR, { create: !!create }); } catch (_) { return null; }
}

// ---------- working folder ----------
async function pickRoot() {
  if (workspaceChangeRefuse()) return;
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'zoost-root' });
    if (!(await ensurePerm(h))) { status('Permission to the folder was not granted.', 'bad'); return; }
    // The count the CRM twin has always made and this side never did: a folder full of things that
    // are not workspaces is almost always somebody's Documents, and the permission covers all of it.
    // Capped at 80 entries because the answer is «this looks like the wrong folder», not a census.
    let foreign = 0, seen = 0;
    for await (const e of h.values()) {
      if (++seen > 80) break;
      if (e.kind !== 'directory') { foreign++; continue; }
      if (APP_DIRS.includes(e.name)) continue;                      // a product folder - our own layout
      try { await e.getFileHandle(CFG); } catch (_) { foreign++; }  // a workspace from the older flat layout
    }
    if (foreign > 6 && !confirm(`\u00ab${h.name}\u00bb already contains ${foreign} items that are not Zoost workspaces.\n\n`
      + `${BLAST_RADIUS}\n\nUse this folder anyway?`)) return;
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    // **Said before the folder is read, not after it.** `refreshWorkspaces` is what diagnoses the
    // folder, and its diagnosis was overwritten one line later by a green «Working folder: X» -
    // every time, whatever it found. Two of those messages exist nowhere else: «N workspace folders
    // sit directly in X - move the Zoho Analytics ones into X/analytics/», which is the only place
    // the old flat layout is explained, and «Could not read X/analytics», after which
    // `rootGranted` is false while the status line says success and the list underneath says access
    // is not granted. The CRM twin has this order and does not have the defect.
    status(`Working folder: \u00ab${h.name}\u00bb`, 'ok');
    await refreshWorkspaces();
  } catch (e) {
    if (e && e.name === 'AbortError') return;         // the user closed the picker - not an error
    status('Could not open that folder: ' + (e.message || e), 'bad');
  }
}
// A stored handle whose permission lapsed needs *authorisation*, not re-selection. Asking for the
// folder again is what made this panel more annoying than the CRM one: showDirectoryPicker() makes
// the user navigate the filesystem, requestPermission() is a one-click prompt.
async function grantRoot() {
  if (!root) { await pickRoot(); return; }
  try {
    if (!(await ensurePerm(root))) { status('Access denied - Zoost cannot read the working folder.', 'bad'); return; }
    rootGranted = true;
    status(`Access granted to \u00ab${root.name}\u00bb.`, 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Grant failed: ' + (e.message || e), 'bad'); }
}
async function restoreRoot() {
  if (!root) root = await window.idbHandle.get('rootDir');
  if (!root) return;
  rootGranted = await hasPerm(root);
  await refreshWorkspaces();
}

// Workspaces are found by reading each folder's .zoost.json, never by parsing folder names - that is
// what lets a folder be renamed without orphaning it.
async function listWorkspaces() {
  const base = await appRoot(false);
  if (!base) return [];
  const out = [];
  // The enumeration itself can fail - a handle whose permission lapsed, a folder moved or removed
  // since the browser stored it. Unguarded, that threw out of here and left the panel with no
  // workspace list and no explanation. A folder we cannot read is a state to report, not a crash.
  try {
    for await (const e of base.values()) {
      if (e.kind !== 'directory' || e.name.startsWith('.')) continue;
      try {
        const fh = await e.getFileHandle(CFG);
        const cfg = JSON.parse(await (await fh.getFile()).text());
        if (cfg && cfg.workspace) out.push({ id: String(cfg.workspace), name: cfg.name || '', folder: e.name, handle: e, cfg });
      } catch (_) { /* a folder without a config is not a workspace; silently skipped */ }
    }
  } catch (e) {
    rootGranted = false;                       // most often this is a lapsed permission
    status(`Could not read «${root ? root.name : '?'}/${APP_DIR}»: ${e.message || e}. Click the folder button to grant access again.`, 'warn');
    return out;                                // whatever was read before the failure is still true
  }
  return out.sort((a, b) => String(a.name || a.folder || '').localeCompare(String(b.name || b.folder || '')));
}

async function refreshWorkspaces() {
  const sel = $('ws');
  // Word for word the CRM's, including the glyphs and the titles: it is the same control, and it read
  // as a different product for showing «Zoost/analytics» where the other side shows «📁 Zoost». The
  // subfolder is an implementation detail of where workspaces live, not the folder the user picked.
  const rt = $('wsroot');
  const needsGrant = !!root && !rootGranted;
  rt.classList.toggle('needgrant', needsGrant);
  rt.textContent = !root ? '\u{1F4C1} Set working folder\u2026'
    : needsGrant ? `\u{1F513} Grant access to ${root.name}`
    : `\u{1F4C1} ${root.name}`;
  rt.title = !root ? 'Pick the folder that will contain all Zoost workspaces'
    : needsGrant ? 'Chrome dropped the file-system permission for this folder. One click restores it - no folder picker.'
    : `Working folder: ${root.name} - click to choose a different one`;
  if (root && !rootGranted) {
    sel.innerHTML = '<option value="">access not granted</option>';
    dir = null; bound = null; forgetDirs();
    // Word for word the CRM's. The blocker is one click, and saying nothing here left the status line
    // reading "Ready." while nothing could be read at all.
    status('Click \u00abGrant access\u00bb above, or anywhere in this panel - one click, no folder picker.', 'warn');
    render(); return updateButtons();
  }
  if (!root) { sel.innerHTML = '<option value="">no working folder yet</option>'; dir = null; bound = null; render(); return updateButtons(); }

  const list = (await listWorkspaces()).sort(byWsLabel);
  wsList = list;
  // Folders sitting directly in the working folder are the older flat layout. This is not a
  // compatibility fallback - nothing keeps working the old way - it is an empty state that says
  // what it sees instead of reporting "no workspaces" while the folders are plainly there.
  let stray = 0;
  try {
    for await (const e of root.values()) {   // same exposure as above; the catch below covers it
      if (e.kind !== 'directory' || APP_DIRS.includes(e.name) || e.name.startsWith('.')) continue;
      try { await e.getFileHandle(CFG); stray++; } catch (_) {}
    }
  } catch (_) {}

  if (!list.length) {
    sel.innerHTML = `<option value="">${esc(root.name)}/${APP_DIR} - no workspaces yet</option>`;
    if (stray) status(`${stray} workspace folder(s) sit directly in «${root.name}». Each Zoost product keeps its own - move the Zoho Analytics ones into «${root.name}/${APP_DIR}/» and reopen the panel.`, 'warn');
    // The remembered sample id is refreshed from the list below - «including to null, which is how
    // deleting the sample stops the button offering to open one that is gone». This return is the one
    // path that never reaches it: delete the sample when it is the *only* workspace and the id stays
    // in storage, so `updateSampleButtons()` hides «+ Sample» for good - while the empty state two
    // lines down is telling the reader to press it. It survives a reload, because the stale id is
    // restored from storage on start.
    // Only when the folder was actually read. `listWorkspaces()` returns an empty array *both* when
    // there are no workspaces and when the enumeration failed - a lapsed permission, a folder that
    // moved - and forgetting the sample on the second is the regression this line caused the day it
    // was added: the remembered id exists precisely because an unreadable folder cannot tell a
    // sample apart from no sample, which is what its own comment says, from four reports.
    if (rootGranted) noteSampleWs(null);
    // **And the workspace that is gone goes with it.** `dir` and `bound` were cleared and the model
    // was not, so the list went on drawing all 39 views of a folder the panel could no longer read -
    // with the diagram, the audit, the assistant and both exports still enabled, because they gate on
    // `views.length`. You could export a workspace that is not there. The twin blanks its tree and
    // switches its six local controls off in this same state.
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null;
    dir = null; bound = null; forgetDirs(); render(); return updateButtons();
  }
  sel.innerHTML = list.map((w) => `<option value="${escA(w.id)}" title="${escA(wsOptionTitle(w))}">${esc(wsOptionText(w))}</option>`).join('');
  // The list is real now, so the remembered answer is refreshed from it - including to null,
  // which is how deleting the sample stops the button offering to open one that is gone.
  noteSampleWs((wsList.find((w) => w.cfg && w.cfg.sample) || {}).id || null);
  const active = await window.idbHandle.get('activeWsAnalytics');
  const pick = list.find((w) => w.id === active) || list[0];
  sel.value = pick.id;
  await selectWorkspace(pick);
}

/** Everything that belongs to the workspace you were in, dropped when you leave it.
 *
 * The conversation stayed on screen across a workspace switch: the assistant's own replies name
 * views, columns and query tables from the workspace you have just left, sitting above a question
 * about the new one, and the whole thread is re-sent with every message - so the model is asked to
 * reason about two workspaces at once and told nothing about the boundary.
 *
 * Byte for byte the CRM panel's, minus the caches it has and this one does not: here `loadFromDisk()`
 * replaces `views`, `schema` and `lineage` wholesale on every switch, so there is nothing else to drop.
 */
function dropWorkspaceState() {
  const had = aiMessages.length;
  aiGen++;
  aiMessages = []; aiSeedWarned = false; aiBusy = false;
  const send = $('aisend'); if (send) send.disabled = false;
  aiRenderMessages();
  return had;
}
/** What is on *screen* when a different workspace is opened - the other half of the above.
 *
 *  Reported on the CRM panel and true here for the same reason: switch workspace with the Health
 *  view open and nothing changes, because what the switch rebuilds is the list underneath an overlay
 *  covering it. A search term typed for one workspace silently narrows the next one too.
 *
 *  Two functions rather than one, and the split is not cosmetic: `dropWorkspaceState()` is what
 *  **Clear** in the chat calls, and Clear must not empty the reader's search box. The selection and
 *  the detail pane are not here because `loadFromDisk()` already drops them on every load. */
function resetView() {
  paintSearchControls(searchState.reset());
  if ($('healthview').classList.contains('show')) renderHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
  if ($('overviewview').classList.contains('show')) renderOverview();
}

const OVERVIEW_STATE = {
  ready: 'Ready', partial: 'Partial', behind: 'Behind', unavailable: 'Not available', 'not-read': 'Not read',
};
function renderOverview() {
  // An interrupted pull deliberately clears the in-memory snapshot: zero would mean Zoho really
  // contains no objects, while these arrays mean only «we refused to load a hybrid mirror».
  // Ignore diagnostics from the workspace left behind as well; the interrupted marker is the one
  // fact this snapshot can establish until Pull all replaces it.
  const unreadable = pullInterrupted ? [] : (diskUnreadableAll || []);
  const failed = pullInterrupted ? [] : pullFailed;
  const unread = new Set(unreadable.map((failure) => failure.rel));
  const lastPull = bound && bound.lastPull;
  const knownAt = (value) => pullInterrupted ? null : value;
  const knownCount = (value, at) => at ? value : null;
  const viewAt = knownAt(viewsPulledAt || lastPull);
  const snapshotAt = knownAt(lastPull);
  const model = workspaceOverviewModel({
    workspace: dir,
    name: (bound && (bound.label || bound.name)) || (($('ws').selectedOptions || [])[0] || {}).textContent,
    sample: !!(bound && bound.sample),
    lastPull,
    areas: [
      { id: 'views', label: 'Views', count: unread.has('views.json') ? null : knownCount(views.length, viewAt),
        pulledAt: viewAt, unavailable: unread.has('views.json'), partial: pullInterrupted },
      { id: 'structure', label: 'Tables', count: unread.has('schema.json') ? null : knownCount(Object.keys(schema).length, snapshotAt),
        pulledAt: snapshotAt, unavailable: unread.has('schema.json'), partial: pullInterrupted },
      { id: 'relations', label: 'Relations', count: unread.has('schema.json') ? null : knownCount(relations.length, snapshotAt),
        pulledAt: snapshotAt, unavailable: unread.has('schema.json'), partial: pullInterrupted },
      { id: 'sql', label: 'Query SQL', count: unread.has('sql/index.json') ? null : knownCount(Object.keys(sqls).length, snapshotAt),
        pulledAt: snapshotAt, unavailable: unread.has('sql/index.json'),
        partial: pullInterrupted || failed.some((failure) => failure.stage === 'sql') },
    ],
    issues: [pullInterrupted ? { text: 'The last pull was interrupted; Pull all repairs the local mirror.', action: 'pull' } : '',
      unreadable.length ? { text: `${unreadable.length} local file(s) could not be read.`, action: 'pull' } : '',
      failed.length ? { text: `${failed.length} item(s) could not be read from Zoho in the last pull.`, action: 'retry' } : ''],
  });
  const onboarding = workspaceOnboardingModel({ sample: model.sample,
    mirrorReady: model.sample || (!!model.lastPull && !pullInterrupted) });
  const when = (value) => {
    if (!value) return 'Never pulled';
    const date = new Date(value);
    return isNaN(date) ? String(value) : date.toLocaleString();
  };
  const body = $('overviewbody');
  body.innerHTML = `<div class="ovtitle">${esc(model.name)}</div>`
    + `<div class="ovmeta">${model.sample ? 'Sample workspace - invented data' : `Last pull: ${esc(when(model.lastPull))}`}</div>`
    + (onboarding.visible ? `<section class="ovstart"><h3>Getting started</h3><div class="ovsteps">${onboarding.steps.map((step) => `<div class="ovstep ${escA(step.state)}" data-step="${escA(step.id)}"><i>${step.state === 'done' ? '✓' : step.state === 'current' ? '→' : ''}</i><b>${esc(step.label)}</b><small>${esc(step.detail)}</small></div>`).join('')}</div></section>` : '')
    + `<div class="ovgrid">${model.areas.map((area) => `<div class="ovcard"><div class="ovlabel">${esc(area.label)}</div>`
      + `<div class="ovcount">${area.count === null ? '—' : area.count}</div><div class="ovstate ${area.status}">${OVERVIEW_STATE[area.status]}`
      + `${area.pulledAt ? ` · ${esc(when(area.pulledAt))}` : ''}</div></div>`).join('')}</div>`
    + (model.issues.length ? `<div class="ovissues">${model.issues.map((issue) => `<button class="ovissue" data-action="${escA(issue.action || '')}"${issue.action ? '' : ' disabled'}>${esc(issue.text)}${issue.action ? `<span>${issue.action === 'retry' ? 'Retry' : 'Repair'} →</span>` : ''}</button>`).join('')}</div>` : '')
    + `<div class="ovactions"><button id="ovbrowse"${onboarding.nextAction === 'browse' ? ' class="next"' : ''}>Browse</button><button id="ovpull" class="zbtn${onboarding.nextAction === 'pull' ? ' next' : ''}"${model.sample ? ' hidden' : ''}>Pull all</button>`
    + `<button id="ovgraph" class="lbtn"${$('graph').disabled ? ' disabled' : ''}>ER diagram</button><button id="ovhealth" class="pbtn"${$('health').disabled ? ' disabled' : ''}>Health</button></div>`;
  body.querySelector('#ovbrowse').onclick = closeOverview;
  body.querySelector('#ovpull').onclick = () => { closeOverview(); void pullAll(); };
  body.querySelector('#ovgraph').onclick = () => { closeOverview(); void openSchemaGraph(); };
  body.querySelector('#ovhealth').onclick = () => { closeOverview(); openHealth(); };
  body.querySelectorAll('.ovissue[data-action]').forEach((button) => {
    button.onclick = () => {
      const run = workspaceOverviewAction(button.dataset.action, {
        pull: () => { void pullAll(); }, refresh: () => { void refreshLocal(); },
        retry: () => { void retryFailed(); }, health: () => { openHealth(); },
      });
      if (!run) return;
      closeOverview();
      run();
    };
  });
}
function openOverview() {
  if (!dir) return;
  closeAI(); closeHealth(); navShow(false);
  $('overviewview').classList.add('show'); $('overview').classList.add('on');
  document.body.classList.add('overview-open');
  renderOverview();
}
function closeOverview() {
  $('overviewview').classList.remove('show'); $('overview').classList.remove('on');
  document.body.classList.remove('overview-open');
}

// Which workspace the panel should reopen on, remembered in IndexedDB. Two selections overlapping -
// a slow one, then a fast one - resolved in the order the browser finished them, so the panel showed
// the second and reopened on the first. The write is queued and the queued work asks whether it is
// still the current selection: what is persisted is what is on screen, not what finished last.
let _activeWsWrites = Promise.resolve();
// The queued work is a declaration and not a `.then(cb)`, because a callback is a scope the race
// checker cannot enter - and this one is *about* a race: it asks, after the queue has drained, whether
// the selection it was queued for is still the one on screen. A check like that is exactly what has
// to be readable.
async function writeActiveWhenStillCurrent(key, id, gen, after) {
  await after;
  if (gen !== wsGen) return;                     // another selection overtook this one; it owns the key
  await window.idbHandle.set(key, id);
}
function rememberActive(key, id, gen) {
  _activeWsWrites = writeActiveWhenStillCurrent(key, id, gen, _activeWsWrites);
  return _activeWsWrites;
}
async function selectWorkspace(w) {
  if (pullBusy && bound && String(w.id) !== String(bound.workspace)) {
    $('ws').value = bound.workspace;
    status('Pull in progress - wait for it to finish before changing workspace.', 'warn');
    updateButtons();
    return false;
  }
  const sameWs = bound && bound.workspace === w.id;
  // The generation moves **here**, before the handle does and before anything awaits: an operation
  // still running belongs to the workspace it started in, and it must be able to tell. It used to
  // move inside `dropWorkspaceState()`, which is also what Clear calls - so clearing a conversation
  // interrupted a pull, and in Analytics the line sat after a `return` and never ran at all, which
  // made every guard in that file always true. Both reported.
  const gen = ++wsGen;
  dir = w.handle; forgetDirs();
  bound = { workspace: w.id, name: w.cfg.name || '', origin: w.cfg.origin || '', label: w.cfg.label || '',
            sample: !!w.cfg.sample, lastPull: w.cfg.lastPull || null,
            sv: Number(w.cfg.sv || 0) };
  const op = beginWorkspaceOp();
  await rememberActive('activeWsAnalytics', w.id, gen);
  if (!op.current()) return;   // a second selection overtook this one while IndexedDB was writing
  // Not on a re-selection of the workspace already open - regranting a folder must not throw
  // away a conversation about the workspace you are still in.
  if (!sameWs) {
    const n = dropWorkspaceState();
    if (n) status(`Workspace changed - the assistant's ${n}-message conversation was cleared: it was about the other workspace.`, 'warn');
    // The selection and the back/forward chain belong to the workspace being left: every step in the
    // chain is a view id of that one. `loadFromDisk` drops them, and only on its *successful* path -
    // three returns come first, one of them the mirror it refuses for being interrupted mid-write.
    // Take that route and the panel stands in the new workspace with the old one's view still in the
    // detail pane and ◂ ready to open ids that mean nothing here.
    //
    // Here rather than there, because `loadFromDisk` also runs for ↻ Refresh on the workspace you
    // are already in, and forgetting where you were would be a defect of its own. This is the one
    // place that knows the workspace actually changed.
    selectedId = null; navClear();
    $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  }
  const loaded = await loadFromDisk(op);
  if (!op.current()) return;
  if (!loaded) {
    // The interrupted-mirror path is a valid state of the newly selected workspace, not a reason
    // to leave the old workspace's overlay and filters on screen.
    if (!sameWs) resetView();
    else if ($('overviewview').classList.contains('show')) renderOverview();
    return;
  }
  if (!sameWs) resetView();   // after the load: Health is rendered from what is now in memory
  if (!op.current()) return;
  await refreshContext();
}

async function createWorkspaceForContext(info) {
  setBusy(true, 'Creating the workspace folder…');
  try {
    const base = await appRoot(true);
    if (!base) throw new Error(`could not create the ${APP_DIR}/ folder`);
    const folder = stemOf(info.name || 'workspace', info.workspace);
    const h = await base.getDirectoryHandle(folder, { create: true });
    dir = h; forgetDirs();
    await patchCfg({ workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV, lastPull: null });
    // Remembered before the list is rebuilt, because rebuilding it selects the remembered one - and
    // the remembered one was still the workspace you were in. So «Create workspace for X» created X
    // and then put you back where you were, with the mismatch bar still up and the new folder empty
    // behind it. The CRM twin has always done this; this is the half that was missing here.
    await window.idbHandle.set('activeWsAnalytics', info.workspace);
    // Zoho Analytics does not always give a workspace a name this endpoint can read, and the panel
    // then had nothing to show but the id - «I import a new org and the dropdown tells me nothing».
    // A missing name is said once, beside the control that fixes it, instead of being rendered as a
    // number and left for the reader to work out.
    setBusy(false, info.name
      ? `Workspace «${info.name}» created. Press Pull all.`
      : `Workspace ${info.workspace} created - Zoho Analytics gave it no name. Press ✎ to name it, then Pull all.`);
    $('status').className = 'ok';
    await refreshWorkspaces();
    openOverview();
  } catch (e) {
    setBusy(false, 'Could not create the workspace: ' + (e.message || e));
    $('status').className = 'bad';
  }
}
async function refreshWorkspaceEntryAfterGrant() {
  rootGranted = true;
  await refreshWorkspaces();
}
async function openWorkspaceForContext(have) {
  $('ws').value = have.id;
  return selectWorkspace(have);
}
async function createWorkspaceForEntry() {
  const info = await toBridge({ cmd: 'workspaceInfo', aboutTab: true });
  return createWorkspaceForContext(info);
}
async function addWorkspace() {
  return runWorkspaceEntry({
    refuse: workspaceChangeRefuse,
    root: () => root,
    pickRoot,
    ensurePermission: ensurePerm,
    permissionRefused: () => status(MSG.folder, 'warn'),
    folderWasGranted: () => rootGranted,
    refreshAfterGrant: refreshWorkspaceEntryAfterGrant,
    context: () => (ctx && ctx.workspace ? ctx : null),
    contextMissing: () => status('Open a Zoho Analytics workspace in the active tab first.', 'warn'),
    findExisting: (current) => (wsList || []).find((w) => String(w.id) === String(current.workspace)),
    openExisting: openWorkspaceForContext,
    // The fresh tab identity is needed only when no local workspace exists. `aboutTab` is the
    // deliberately narrow mismatch exception, kept in a named entry adapter the race checker reads.
    create: createWorkspaceForEntry,
  });
}

// Deleting the local mirror only. The confirmation says so explicitly, because "Remove workspace"
// next to a tool that talks to Zoho is exactly the phrase someone reads as "delete it in Zoho".
async function delWorkspace() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !root) return;
  if (!confirm(`Delete the folder «${w.folder}» and everything in it?\n\nThis removes the local mirror only - nothing in Zoho Analytics is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) { status(MSG.folder, 'warn'); return; }
    const base = await appRoot(false);
    if (!base) { status('Could not open the workspace folder.', 'warn'); return; }
    await base.removeEntry(w.folder, { recursive: true });   // delete inside analytics/, never at the root
    await window.idbHandle.set('activeWsAnalytics', null);
    dir = null; bound = null; forgetDirs();
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null;
    $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; navClear();
    status(`Removed \u00ab${w.folder}\u00bb.`, 'ok');
    await refreshWorkspaces();
    render();
  } catch (e) { status('Remove failed: ' + (e.message || e), 'warn'); }
}

// ---------- tab / bridge ----------
async function analyticsTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  return a && HOST_RE.test(a.url || '') ? a.id : null;
}
/** Which of a tab's frames is the Analytics application, decided by asking them.
 *
 * A plain Analytics tab has one document and it is the app. A suite shell has several, and more than
 * one can be on `analytics.zoho.<dc>` - so the frame is not chosen by position, it is **the one that
 * answers**: the bridge replies only from that origin and only with a workspace resolved out of the
 * page's own URL, so it selects itself. The CRM panel learnt this the expensive way, on a tab with
 * thirteen frames and two candidates, where taking the first the enumeration returned meant being
 * refused in a millisecond on every tick.
 *
 * `null` means «no Analytics document in this tab», which is a different fact from «it has one and
 * our bridge is not in it yet» - `_afCandidates` carries that, because conflating the two is what
 * stops the repair from ever running.
 */
let _afCandidates = { tabId: null, ids: [] };
let _afFrame = { tabId: null, frameId: 0, ts: 0 };
async function askFrame(tabId, frameId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, { frameId });
    return { frameId, ok: !!(r && r.ok && r.workspace), why: !r ? 'declined' : r.ok ? 'ok' : 'refused' };
  } catch (_) {
    return { frameId, ok: false, why: 'no-listener' };
  }
}
async function analyticsFrameId(tabId) {
  const now = Date.now();
  // Only a *found* frame is remembered. Recording a miss makes a transient absence last as long as
  // the memo, and a shell rebuilding its iframe is exactly a transient absence.
  if (_afFrame.tabId === tabId && _afFrame.frameId !== null && now - _afFrame.ts < 6000) return _afFrame.frameId;
  let fid = null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true },
                                                       func: () => ({ href: location.href, top: window === window.top }) });
    const seen = (res || []).map((r) => ({ frameId: r.frameId, ...(r.result || {}) }));
    const app = seen.filter((x) => APP_HOST_RE.test(x.href || ''));
    _afCandidates = { tabId, ids: app.map((x) => x.frameId) };
    const top = app.find((x) => x.top);
    if (top) fid = top.frameId;
    else if (app.length === 1) fid = app[0].frameId;
    else if (app.length) {
      const asked = await Promise.all(_afCandidates.ids.map((f) => askFrame(tabId, f)));
      console.info(`[zoost] frames asked [${asked.map((x) => x.frameId + ':' + x.why).join(' ')}]`);
      fid = (asked.find((x) => x.ok) || {}).frameId ?? null;
    }
  } catch (_) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (APP_HOST_RE.test((t && t.url) || '')) fid = 0;
    } catch (_) {}
  }
  if (fid !== null) _afFrame = { tabId, frameId: fid, ts: now };
  return fid;
}
async function ensureBridge(tabId) {
  const fid = await analyticsFrameId(tabId);
  const to = fid === null ? {} : { frameId: fid };
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }, to); return true; }
  catch {
    // Every Analytics-origin frame this tab has, not one of them: a shell builds several and only one
    // is the application, so injecting into whichever came first leaves the one that *would* answer
    // without a bridge. They are all on a host this extension declares a content script for.
    const ids = _afCandidates.tabId === tabId ? _afCandidates.ids : (fid === null ? [] : [fid]);
    if (!ids.length) return false;
    // The one recovery the "never click-and-hope" rule allows: re-inject a script we own, once.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: ids }, files: ['content-bridge.js'] });
      console.info(`[zoost] bridge injected into [${ids.join(' ')}]`);
      await sleep(60);
      _afFrame = { tabId: null, frameId: 0, ts: 0 };   // the lookup ran before any of this existed
      return true;
    } catch (e) {
      console.info(`[zoost] bridge injection REFUSED for [${ids.join(' ')}]: ${(e && e.message) || e}`);
      return false;
    }
  }
}
async function toBridge(msg) {
  // The last line, below every disabled control and every guard above it. The panel speaks to the
  // tab that is open, so a command that is not the context probe must not travel while that tab is a
  // different workspace from the one this panel is bound to - whatever removed the `disabled`, and
  // whoever called the function directly. `context` is how the mismatch is detected in the first
  // place, so it is the one thing that always goes; and a panel with nothing bound yet is creating
  // its first workspace, which is not a mismatch.
  // `aboutTab` is the exception, and it is one command wide. «Create workspace for <id>» is the
  // control this panel *offers* to resolve a mismatch, and it needs the tab's workspace name to name
  // the folder - which is a bridge call, which this line refused. So the way out of the state was
  // refused by the guard on that state: press it and you got «nothing here reads Zoho Analytics until
  // they match», about the very act of making them match. Found by the author on the first manual
  // check of a release, in the first minute of it.
  //
  // What makes it safe to let through is not that it is a create: it is that `workspaceInfo` in the
  // bridge resolves its id from the **page's own URL** and takes nothing from the message, so it can
  // only ever describe the workspace the tab is on. There is no parameter through which another
  // workspace could be named, and a test holds both halves of that.
  const aboutTab = !!(msg && msg.aboutTab);
  if (msg && msg.cmd !== 'context' && !aboutTab && bound && !guardOk()) throw new Error(MSG.mismatchRefused);
  const id = await analyticsTabId();
  if (id == null) throw new Error('The active tab is not Zoho Analytics.');
  await ensureBridge(id);
  // The identity travels with the command and is checked *in the page that will run it* - see the
  // note in the CRM twin. Everything above is a check against a memory of which workspace the tab
  // was showing, with three awaits between reading it and arriving.
  // The same exception, one layer down: the page refuses a command whose `__zoostExpected` does not
  // match it, and the whole point here is that it does not - we are asking a tab about itself while
  // bound elsewhere. Sending the binding would have the page refuse what the panel just allowed.
  const expected = (msg && msg.cmd !== 'context' && !aboutTab && bound)
    ? { workspace: bound.workspace, origin: bound.origin } : null;
  // The Analytics frame, like the context probe. A command addressed to the whole tab reaches the
  // shell as well, and the bridge is not the only listener a page may have.
  const afid = await analyticsFrameId(id);
  const r = await chrome.tabs.sendMessage(id, expected ? { ...msg, __zoostExpected: expected } : msg,
                                          afid === null ? {} : { frameId: afid });
  if (!r) throw new Error('No answer from the Zoho Analytics page.');
  // Rebuild the Error with the two fields the reply carries, or the classification made in the
  // bridge is thrown away one line after crossing the boundary - which is how "your role does not
  // allow this" would end up displayed as a bare status code again.
  if (r.ok === false) {
    const e = new Error(r.error || 'unknown error');
    e.status = r.status || 0; e.forbidden = !!r.forbidden;
    throw e;
  }
  return r;
}

// ---------- context bar + environment guard ----------
// A workspace of invented data, written by «+ Sample» rather than pulled. It is an ordinary
// workspace in every other respect - the same list, the same walks, the same exports - and there is
// no demo *mode* anywhere: an `if (demo)` branch in rendering code is how invented data eventually
// gets shown as somebody's own. This flag exists so nothing talks to Zoho Analytics about it.
const isSample = () => !!(bound && bound.sample);
// Everything platform-bound funnels through here, so this is the one place a sample has to be
// refused - rather than a condition repeated at each button, where one is eventually forgotten.
const guardOk = () => !isSample() && !!(bound && ctx && ctx.workspace && String(ctx.workspace) === String(bound.workspace));
// The one refusal every «open this in Zoho Analytics» navigation makes. A sample workspace has no
// Zoho Analytics workspace behind it, so a link built from its id would open a URL that does not
// exist: refused with a reason rather than left to 404, because «nothing talks to the platform» has
// to be true of the navigations too, or it is not the claim the guide makes. It reads as
// `if (sampleRefuse()) return;` at each site, instead of the same string copied at both of them.
// Everything that reads or writes through Zoho asks this first, at the moment it would act. It used
// to be enough that the control was disabled or covered - which is protection by position on screen,
// and it held only until somebody put a Zoho-bound action somewhere nobody had thought about. One
// had already got out: a click on a row of the tree that is not downloaded yet fetches that function
// from Zoho, and nothing but the mismatch overlay stood in front of it. Reported as a rule rather
// than as a bug: «since Pull is disabled, everything that talks to Zoho should be».
function mismatchRefuse() {
  if (guardOk()) return false;
  status(MSG.mismatchRefused, 'warn');
  return true;
}
function sampleRefuse() {
  if (!isSample()) return false;
  status('This is the sample workspace - there is no Zoho Analytics workspace to open.', 'warn');
  return true;
}

let contextLoad = 0;
let _ctxErr = null;
async function refreshContext() {
  const mine = ++contextLoad;
  const current = () => mine === contextLoad;
  const el = $('ctx'), who = $('who'), bnd = $('bound');
  const id = await analyticsTabId();
  if (!current()) return;
  const localLbl = bound
    ? `<span class="rlbl local">Workspace</span>«${esc(bound.name || bound.workspace)}» ${esc(bound.workspace)}`
    : '<span class="rlbl local">Workspace</span><span>not bound yet</span>';

  if (id == null) {                                  // the ACTIVE tab is not Analytics
    ctx = null;
    // Not over a sample - see the note in the CRM panel: a Zoho Analytics tab is not a
    // precondition for reading invented data.
    // `sampleBusy` belongs here and not only at the click. This panel re-derives its whole state on
    // a five-second poll, so anything set imperatively on top of that is undone by the next tick -
    // reported as the overlay coming back in the middle of writing the sample and then leaving
    // again. A state that has to hold across time is a term in the condition, never an assignment.
    $('offoverlay').classList.toggle('show', !isSample() && !sampleBusy);
    $('mmbar').classList.remove('show');
    el.className = 'offzoho'; who.innerHTML = 'Not on a Zoho Analytics tab'; bnd.innerHTML = localLbl;
    return updateButtons();
  }
  $('offoverlay').classList.remove('show');
  await ensureBridge(id);
  if (!current()) return;
  const afid = await analyticsFrameId(id);
  if (!current()) return;
  try {
    // The frame, when we know which one. Broadcasting to the tab worked while there was one document
    // per tab; inside a shell it asks the shell as well, and «nobody answered» is then a statement
    // about the wrong document.
    const r = await chrome.tabs.sendMessage(id, { cmd: 'context' }, afid === null ? {} : { frameId: afid });
    if (!current()) return;
    ctx = r && r.ok ? r : null;
  } catch (e) { if (!current()) return; ctx = null; _ctxErr = (e && e.message) || String(e); }

  // The sequence, one line per tick, in the order things happened - the same record the CRM panel
  // keeps. «Not ready» is a state the panel *arrives at*, and the only account of arriving at it was
  // the words on screen, which say that it happened and nothing about why. No path is printed: a
  // path carries a workspace name and this line ends up pasted into a chat.
  console.info(`[zoost] ctx tab=${id} -> ${ctx ? (ctx.workspace ? 'ok' : 'ok, no workspace open') : 'NOT READY'
    + (_ctxErr ? ' (' + _ctxErr + ')' : '')}`);
  _ctxErr = null;

  if (!ctx) { el.className = 'offzoho'; who.innerHTML = 'Zoho Analytics tab (not ready - reload it)'; bnd.innerHTML = localLbl; }
  else if (!ctx.workspace) { el.className = 'offzoho'; who.innerHTML = '<span class="rlbl remote">Zoho Analytics tab</span><span>no workspace open</span>'; bnd.innerHTML = localLbl; }
  else {
    // True and irrelevant on a sample: the tab really is on that workspace, and this folder has
    // nothing to do with it. Two halves side by side otherwise imply a relationship there is not.
    who.innerHTML = `<span class="rlbl remote">Zoho Analytics tab</span><b>${esc(ctx.workspace)}</b>${isSample() ? '<span> · not related to the sample</span>' : ''}`;
    if (!bound) { el.className = 'unbound'; bnd.innerHTML = localLbl; }
    else if (guardOk()) { el.className = 'match'; bnd.innerHTML = localLbl + ' ✓'; }
    // Not a mismatch: the mismatch bar is for two workspaces that could match, and this one never
    // will. It says what it is instead.
    else if (isSample()) { el.className = 'unbound'; bnd.innerHTML = '<span class="rlbl local">Workspace</span><span style="color:var(--muted)">sample - generated, never pulled</span>'; }
    else { el.className = 'mismatch'; bnd.innerHTML = localLbl + ' ✗'; }
  }

  // The mismatch bar offers the one action that resolves it, and the overlay makes it impossible to
  // browse one workspace's mirror while looking at another. Same guarantee as the CRM panel's.
  // The discrepancy is stated in both cases, the sample included: reading invented data while
  // looking at a real workspace is exactly what this bar is for. What differs is the **blocking**,
  // and only that - a real mismatch can be resolved, a sample never will be, everything
  // platform-bound is already refused for it, and blocking would make it unusable the whole time an
  // Analytics tab is open. Say it, do not stop it.
  const sampleMm = !!(bound && ctx && ctx.workspace && isSample());
  const mm = !!(bound && ctx && ctx.workspace && !guardOk() && !isSample());
  $('mmbar').classList.toggle('show', mm || sampleMm);
  $('mmbar').classList.toggle('soft', sampleMm);
  if (mm || sampleMm) {
  // **The sample is a state the user chose, and it was being announced like an accident.** Three
  // sentences on one screen said the same fact - the status line's «not related to the sample», the
  // workspace chip's «sample - generated, never pulled», and a full paragraph in the bar - and the
  // bar then offered a full-width «Create workspace for ...», which is the control the workspace row
  // already carries and has enabled in exactly this state. One fact three times, one action twice.
  //
  // What the bar alone was carrying is the *reason*: `guardOk()` is false for a sample, so Pull is
  // disabled, and nothing else on screen says why. So it keeps that and loses the rest - one line,
  // no call to action. A real mismatch is unchanged: that one is accidental, it can be resolved, and
  // the two buttons are how.
    $('mmtext').textContent = sampleMm
      ? `Sample workspace - invented data. Pulling is off: nothing here comes from workspace ${ctx.workspace}, and nothing here can reach it.`
      : `The tab is workspace ${ctx.workspace}; this folder mirrors \u00ab${wsShown(bound)}\u00bb (${bound.workspace}). Pulling is off until they match; what is already mirrored stays readable.`;
    // Two ways out, as the CRM offers: take the tab to the bound workspace, or move this panel to
    // the workspace the tab is already in - switching to it if it exists locally, creating it if not.
    // The first is meaningless for a sample: there is no Zoho Analytics workspace to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${wsShown(bound)}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id === String(ctx.workspace) && w.id !== bound.workspace);
    const sw = $('mmsw'); sw.className = 'znav'; sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${wsShown(match) || match.folder}\u00bb`; sw.onclick = () => { $('ws').value = match.id; selectWorkspace(match); }; }
    else { sw.textContent = `Create workspace for \u00ab${ctx.workspace}\u00bb`; sw.onclick = () => addWorkspace(); }
  }
  updateButtons();
}

// Both are a plain navigation to a URL we construct ourselves - no clicking through Zoho's UI, and
// nothing that depends on what the page happens to look like.
// Two intentions, and one helper was serving both. «Switch tab» means *this workspace's* org, where
// the workspace path is exactly right; «Go to Zoho Analytics» means the platform, and sending it to
// a workspace id is the CRM's own bug one product over - log out to sign in elsewhere and the button
// returns you to the account you just left. The host is derived from what is known and the setting
// is consulted only when nothing is.
/** The data centres, and the choice offered where the link is.
 *
 *  The destination used to be derived from whichever workspace happened to be open, on the reasoning
 *  that a data centre is a property of an account and signing out does not move it. True of one
 *  account, and false for the reader this product is most for: a consultant with clients on .eu,
 *  .com and .jp cannot have it deduced, because after signing out the next org is a choice nobody
 *  but them has made yet. Reported, and the earlier reasoning was mine and wrong.
 *
 *  So the picklist is beside the button and is always there, offering every data centre rather than
 *  the ones already mirrored - wanting to open .jp while the default is .eu is exactly the case, and
 *  a control that only offers what you have been to before cannot serve it. What it opens on is what
 *  is known: the workspace, then the tab, then the default in Settings. */
/** The data centres, derived from the manifest instead of typed.
 *
 *  It was a literal list in two places - here and the Settings form - held together by a test,
 *  which is a checker standing in for a source of truth. The manifest already *is* that source:
 *  a host this extension cannot reach is not a destination it may offer, and one it can reach is.
 *  Adding a data centre is then one edit, in the file that has to change anyway.
 *
 *  Measured while asking whether the list was complete, and it is not: Zoho answers on
 *  zoho.sa, zoho.uk, zoho.ae and zoho.com.cn with the same shape as the six here, and neither
 *  manifest grants them. That is a permissions change and is not made in passing. */
const DCS = [...new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => h.startsWith('https://analytics.'))
  .map((h) => h.slice('https://analytics.'.length).replace(/\/.*$/, '')))].sort();
const dcOf = (origin) => (String(origin || '').match(/^https:\/\/[^.]+\.(.+)$/) || [])[1] || null;
function renderGoDc() {
  const sel = $('gozohodc'); if (!sel) return;
  const want = sel.dataset.touched ? sel.value
    : (dcOf(bound && bound.origin) || dcOf(ctx && ctx.origin) || zohoDc);
  if (sel.options.length !== DCS.length) {
    sel.innerHTML = DCS.map((d) => `<option value="${escA(d)}">${esc(d)}</option>`).join('');
  }
  sel.value = DCS.includes(want) ? want : DCS[0];
}
const homeUrl = () => {
  const dc = ($('gozohodc') && $('gozohodc').value)
    || dcOf(bound && bound.origin) || dcOf(ctx && ctx.origin) || zohoDc;
  return `https://analytics.${dc}/`;
};
// Where a view lives in Zoho Analytics. One shape for everything - a table, a query table, a report,
// a dashboard - read out of the address bar rather than guessed at:
//   https://analytics.<dc>/workspace/<workspace id>/view/<view id>
// Built from what the mirror already knows, which is what makes it a navigation and not a search:
// no synthetic clicks, nothing that depends on Zoho's markup or on the interface language. The
// origin is the workspace's own, so a panel bound to one workspace opens that one's views even while
// the tab is somewhere else.
function viewUrl(id) {
  if (!bound || !bound.origin || !bound.workspace || !id) return null;
  return `${bound.origin}/workspace/${bound.workspace}/view/${encodeURIComponent(String(id))}`;
}
const workspaceUrl = () => (bound && bound.origin && bound.workspace
  ? `${bound.origin}/workspace/${bound.workspace}` : homeUrl());
/** Take the reader to a page of their Zoho Analytics, without taking their shell away.
 *
 * A tab is a tree of documents. On a plain Analytics tab there is one and it is the app; inside a
 * suite shell the app is a frame and the *tab* is the shell, so navigating the tab throws away the
 * shell the reader was working in. Frame 0 is the tab's own document, so this navigates the tab
 * there and one path serves both. A refused injection falls back to the tab, which is where this
 * started.
 */
// **Nothing navigates anywhere this extension is not allowed to be.** «Open in Zoho» builds its URL
// from `bound.origin`, and `bound` is `.zoost.json` - a file on disk, in a folder the user may have
// been given rather than made. The pull compares that origin against the tab; no navigation asked
// anything, so a workspace received from somebody else could point a control labelled with Zoho's
// name at any origin, inside the user's own Zoho frame. Written the same way in the twin.
//
// The check is here and not at the call sites, so one added tomorrow inherits it. `APP_HOST_RE` is
// the application's own origin: a workspace URL that is not on it is not a workspace URL.
// The application's own hosts, exactly, out of `host_permissions` - not a prefix. A prefix test lets
// `https://analytics.zoho.eu.evil.com/` through, which is the whole point of the check.
const APP_HOSTS = new Set((chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => /^https:\/\/analytics\./.test(h))
  .map((h) => { try { return new URL(h.replace(/\*$/, '')).host; } catch (_) { return null; } })
  .filter(Boolean));
function zohoUrlOk(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && APP_HOSTS.has(u.host);
  } catch (_) { return false; }
}
async function goToZoho(url) {
  if (!zohoUrlOk(url)) {
    status('This workspace points at ' + (((url || '').match(/^https?:\/\/[^/]+/) || [])[0] || 'somewhere')
      + ', which is not a Zoho Analytics address. Nothing was opened - check where this workspace folder came from.', 'bad');
    return null;
  }
  const id = await analyticsTabId();
  if (!id) { const t = await chrome.tabs.create({ url, active: true }); return t.id; }
  const fid = await analyticsFrameId(id);
  if (fid) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [fid] },
                                             func: (u) => { location.href = u; }, args: [url] });
      await chrome.tabs.update(id, { active: true });
      return id;
    } catch (_) { /* fall through to the tab */ }
  }
  await chrome.tabs.update(id, { url, active: true });
  return id;
}
async function switchTab() {
  if (sampleRefuse()) return;
  await goToZoho(workspaceUrl());
}
/** The way *in*, and deliberately the tab rather than a frame: this is the control for when there is
 *  no context at all, and a reader who presses it is asking to go to Zoho Analytics, not to move a
 *  frame inside a page they may not be on. The CRM's own home button is the same. */
async function openZohoHome() {
  if (sampleRefuse()) return;
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = homeUrl();
  if (a && HOST_RE.test(a.url || '')) await chrome.tabs.update(a.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}

function updateButtons() {
  if (!dir) closeOverview();
  renderGoDc();                      // the list it offers is the workspaces, so it moves with them
  $('ws').disabled = pullBusy;
  $('wsroot').disabled = pullBusy;
  // Same rule as the CRM panel, and the same reason. Analytics had no such check at all: it left
  // the button offering to "create" a workspace that already existed, and reopened the same folder.
  // Harmless, and still a control saying it will do something it will not.
  const known = (wsList || []).find((w) => ctx && ctx.workspace && String(w.id) === String(ctx.workspace));
  $('wsdel').disabled = pullBusy || busy || !dir || !wsList.length;
  $('wsrename').disabled = pullBusy || busy || !dir || !wsList.length;
  // Why each is grey, in the order the states block each other - the same order `emptyReason()`
  // walks, because a control and the empty state under it must not name different blockers. `Pull`
  // has said this since it was written; these three went grey with nothing on them, which is a dead
  // end the reader cannot act on. The strip of detail tabs learnt the same thing this morning.
  // The reasons, once. Six controls in this function are switched off by the same two facts, and
  // writing them out per control is how a message drifts from its twin - the duplicate-message check
  // caught exactly that here, on the pair I had just written.
  const BUSY = 'the panel is busy';
  const UNREAD = 'nothing has been read from this workspace yet - press Pull all';
  const wsWhy = pullBusy ? 'a pull is running'
    : busy ? 'the panel is busy'
      : !root ? 'no working folder yet - press the folder button'
        : !rootGranted ? 'folder access is not granted - press Grant access'
          : null;
  const addView = addWorkspaceView(known, pullBusy || busy, ctx, root && root.name, rootGranted, wsWhy);
  $('wsadd').hidden = addView.hidden;
  $('wsadd').disabled = addView.disabled;
  $('wsadd').textContent = addView.label;
  $('wsadd').title = addView.title;
  // Absent once one exists, and the overlay's copy says which of the two it will do. Both are
  // decided in one place, because they were decided in two and disagreed.
  updateSampleButtons();
  // Written out rather than looped: the check that holds this rule reads `$('id').title`, and a loop
  // over the ids hides it from the one thing that keeps it true. Two buttons, two lines.
  $('wsdel').title = !$('wsdel').disabled ? 'Remove this workspace from the folder'
    : `Cannot remove a workspace: ${wsWhy || 'none is selected'}`;
  $('wsrename').title = !$('wsrename').disabled ? 'Give this workspace a name of your own'
    : `Cannot name a workspace: ${wsWhy || 'none is selected'}`;
  $('pull').disabled = busy || !dir || !guardOk();
  $('overview').disabled = busy || !dir;
  $('overview').title = !$('overview').disabled ? 'Workspace overview - local coverage and shortcuts'
    : `Cannot open overview: ${busy ? BUSY : 'no workspace is open'}`;
  // Absent, not disabled, when there is nothing to retry - the CRM's equivalent does the same.
  // A greyed button still says "there is something here you cannot have", which is misleading
  // when there is no something. The label carries the count, so the button is self-explaining.
  const rb = $('retry');
  rb.style.display = pullFailed.length ? '' : 'none';
  rb.textContent = `Retry ${pullFailed.length} failed`;
  rb.disabled = busy || !dir || !guardOk();
  $('refresh').disabled = busy || (!dir && !(root && !rootGranted));
  $('refresh').title = !$('refresh').disabled ? 'Read every file in this workspace again'
    : busy ? 'Cannot refresh: the panel is busy'
      : 'Cannot refresh: no workspace is open, and the folder access is not waiting to be granted';
  const loaded = views.length > 0;
  $('export').disabled = busy || !loaded;
  $('export').title = !$('export').disabled ? 'Export this workspace as a self-contained file'
    : `Cannot export: ${busy ? BUSY : UNREAD}`;
  $('exportmd').disabled = busy || !loaded;
  $('exportmd').title = !$('exportmd').disabled ? 'Export this workspace as context for an AI tool'
    : `Cannot export: ${busy ? BUSY : UNREAD}`;
  $('graph').disabled = busy || !Object.keys(schema).length;
  $('graph').title = !$('graph').disabled ? 'Open the ER diagram in its own window'
    : `Cannot draw: ${busy ? BUSY : 'no table structure has been read yet - press Pull all'}`;
  $('health').disabled = busy || !loaded;
  $('health').title = !$('health').disabled ? 'What nothing depends on, and what is unused'
    : `Cannot audit: ${busy ? BUSY : UNREAD}`;
  $('askai').disabled = busy || !loaded;
  $('askai').title = !$('askai').disabled ? 'Ask about this workspace'
    : `Cannot ask: ${busy ? BUSY : UNREAD}`;
  // Back to the button's own title, never to nothing. This wrote '' on every state refresh, which
  // was survivable while the button said "Pull all" and is not now that it is a mark: the tooltip is
  // where the name lives. A control that loses its name on the first repaint has no name.
  $('pull').title = $('pull').disabled && dir && ctx && ctx.workspace && !guardOk()
    ? 'The active tab is a different workspace from the one selected here.'
    : PULL_TITLE;
}
function setBusy(on, text) {
  busy = on;
  // `null` means «leave the status line alone»: the caller has already put the right sentence there
  // and «Ready.» would be a lie over it. One path did exactly that - see refreshLocal().
  if (text !== null) status(text || (on ? 'Working…' : 'Ready.'), on ? 'busy' : '');
  updateButtons();
}
function setPullBusy(on) {
  pullDepth = Math.max(0, pullDepth + (on ? 1 : -1));
  pullBusy = pullDepth > 0;
  updateButtons();
}
function workspaceChangeRefuse() {
  if (!pullBusy) return false;
  $('ws').value = bound ? bound.workspace : '';
  status('Pull in progress - workspace unchanged.', 'warn');
  updateButtons();
  return true;
}

// An operation that has been overtaken stops - and stopping must not leave the panel it is no longer
// in looking like something is running there. It says nothing: the workspace on screen has just been
// loaded and has already said what it has to say, and a sentence about the org you left is noise at
// best. Only the busy state, which is what greys the buttons, is put down.
function endBusyElsewhere() { busy = false; updateButtons(); }

function refuseIncompleteSnapshot() {
  views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null; pullFailed = [];
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
  // The same state `loadFromDisk` sets when it finds the marker on disk, and it was set there only:
  // three catch blocks reach this function, and after them the empty list fell through to «Nothing
  // pulled yet. Press Pull all» while the status line one row above said the pull had been
  // interrupted mid-write. Two surfaces, two explanations, and the list's was the false one.
  //
  // Wiring one of four call sites is the defect this repository asks about in its own second
  // question - «who else owns this flag?» - applied to a flag I had just added.
  pullInterrupted = true;
  diskUnreadable = null;   // it is not an unreadable file; naming one would send the reader to fix it
  diskUnreadableAll = [];
  render();
}

// ---------- pull ----------
async function pullAll() {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace this pull belongs to, carried rather than re-read
  if (mismatchRefuse()) return;
  const onProgress = (m) => { if (m?.type === 'pullProgress') op.say(`Pulling ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setPullBusy(true);
  setBusy(true, 'Pulling…');
  try {
    await requirePerm(op.root);
    setBusy(true, 'Reading the workspace…');
    const info = await toBridge({ cmd: 'workspaceInfo' });

    // Built whole, published whole. The four stages used to land in the globals one by one, so a
    // stage that failed left the panel holding the new views over the old schema - a photograph of
    // two different moments, on screen and in every export until the next successful pull.
    // Reproduced by an outside scan with `workspaceErd` failing after `listViews`.
    setBusy(true, 'Reading the view list…');
    const vl = await toBridge({ cmd: 'listViews' });
    if (!op.current()) return endBusyElsewhere();   // the answer describes the workspace we were in, not this one

    setBusy(true, 'Reading structure and relations…');
    const sc = await toBridge({ cmd: 'workspaceErd' });
    if (!op.current()) return endBusyElsewhere();

    const nextViews = vl.views || [];
    const qIds = nextViews.filter((v) => v.type === 'QueryTable').map((v) => v.id);
    setBusy(true, `Reading SQL… 0 / ${qIds.length}`);
    const sq = await toBridge({ cmd: 'pullSql', ids: qIds });
    if (!op.current()) return endBusyElsewhere();

    const allIds = nextViews.map((v) => v.id);
    setBusy(true, `Reading lineage… 0 / ${allIds.length}`);
    const dp = await toBridge({ cmd: 'scanDependencies', ids: allIds });
    if (!op.current()) return endBusyElsewhere();

    // The stage travels with each failure: «could not read» means nothing actionable until it says
    // which half - and sqlState() tells an unread query from an absent one by exactly this field.
    const next = {
      views: nextViews, folders: vl.folders || [],
      schema: sc.tables || {}, relations: sc.relations || [],
      sqls: sq.sql || {}, deps: dp.deps || {},
      pullFailed: [].concat((sq.failed || []).map((f) => ({ ...f, stage: 'sql' })),
                            (dp.failed || []).map((f) => ({ ...f, stage: 'lineage' }))),
    };
    if (!(await writeToDisk(info, op, next))) return endBusyElsewhere();
    ({ views, folders, schema, relations, sqls, deps, pullFailed } = next);
    mergeSchemaIntoViews();

    const orphans = views.filter(isOrphanCandidate).length;
    const cols = Object.values(schema).reduce((n, t) => n + t.columns.length, 0);
    setBusy(false, `${views.length} views · ${Object.keys(schema).length} tables · ${cols} columns · ${relations.length} relations · ${qIds.length} SQL · ${orphans} nothing depends on`
      + (pullFailed.length ? ` · ${pullFailed.length} could not be read` : '')
      + (next.cleanupFailed ? ` · ${next.cleanupFailed} old SQL file(s) could not be removed - the next pull retries` : ''));
    $('status').className = (pullFailed.length || next.cleanupFailed) ? 'warn' : 'ok';
    render();
  } catch (e) {
    // Once the `writing` marker landed, the files on disk may be from two moments. Keeping the old
    // globals alive in this same panel let exports and the assistant combine that old snapshot with
    // whichever SQL files had already been replaced. Refuse it immediately, not only after reopen.
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    // A refusal is not a fault, and saying "Pull failed: 403" for one sends the user looking for a
    // bug in Zoost instead of to whoever administers their Analytics roles.
    setBusy(false, interrupted
      ? 'Pull was interrupted while writing. The mirror is blocked because its files describe two different moments - run Pull all to repair it.'
      : e && e.forbidden
      ? `Your Zoho Analytics role does not grant access to this workspace${e.status ? ` (Zoho Analytics answered ${e.status})` : ''}. Nothing was written - what is on disk is unchanged.`
      // Through `friendlyError`, which exists for exactly this and was used on three paths, none of
      // them the one that runs longest. A pull is minutes of network work, and Chrome lets the
      // folder permission lapse while it runs: the last stage then threw
      // `NotAllowedError: The request is not allowed by the user agent…` and the panel printed it
      // whole - a platform sentence naming neither the folder nor the button that fixes it, at the
      // end of a long wait. Reported from a real workspace, which is the only place the wait is
      // long enough. Nothing was written when it happens here: the marker is the first thing the
      // write stage does, so a refusal at that moment leaves the previous snapshot intact.
      : 'Pull failed: ' + friendlyError(e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
    noteThrown(e);   // what the report will be about, if they press the button it just showed
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    setPullBusy(false);
  }
}

// A pull has two very different kinds of failure, and conflating them would be dishonest.
//
//   - **A stage fails.** The view list, the structure or the ER model is one call each: if it does
//     not answer there is no partial answer to keep, so the pull stops and nothing is written. What
//     was on disk before is left exactly as it was.
//   - **An item fails.** SQL and lineage are one call per view. One unreadable view must not cost
//     the other four hundred, so those are collected into `pullFailed`, the pull finishes, and the
//     panel says how many were missed. The mirror is written *with the gap declared* rather than
//     silently short.
//
// Both are recoverable without re-downloading the workspace: `retryFailed()` re-reads exactly the
// items that failed, and `pullOne()` re-reads a single view from its detail pane.
async function pullOne(id) {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace this re-read belongs to
  // `pullSql` reports a *per-item* failure in `failed` and does not throw: this read the ids it had
  // asked for out of `pullFailed` regardless and finished ««Q1» re-read.», so a view whose SQL is
  // still the old file - or absent - stopped being marked as incomplete. The panel, the export and
  // the assistant then treat it as whole. Same shape as every «did not read» in the CRM: an answer
  // that did not arrive is not an answer that says nothing is there.
  const still = [];
  if (mismatchRefuse()) return;
  const v = viewById().get(id);
  if (!v) return;
  setPullBusy(true);
  setBusy(true, `Re-reading «${v.name}»…`);
  try {
    await requirePerm(op.root);
    const nextSqls = { ...sqls };
    const nextDeps = { ...(deps || {}) };
    if (v.type === 'QueryTable') {
      const r = await toBridge({ cmd: 'pullSql', ids: [id] });
      if (!op.current()) return endBusyElsewhere();
      if (r.sql && r.sql[id]) nextSqls[id] = r.sql[id];
      still.push(...(r.failed || []).map((f) => ({ ...f, stage: 'sql' })));
    }
    const d = await toBridge({ cmd: 'viewDependencies', id });
    if (!op.current()) return endBusyElsewhere();
    nextDeps[id] = { id: d.id, parents: d.parents, children: d.children, dashboards: d.dashboards };
    // Only this item's old report goes, and only if this pull actually replaced it.
    const nextFailed = pullFailed.filter((f) => String(f.id) !== String(id)).concat(still);
    await writePartialSnapshot(op, { sqls: nextSqls, deps: nextDeps, pullFailed: nextFailed });
    if (!op.current()) return endBusyElsewhere();
    ({ sqls, deps, pullFailed } = { sqls: nextSqls, deps: nextDeps, pullFailed: nextFailed });
    setBusy(false, still.length ? `«${v.name}»: lineage re-read, its SQL still could not be.` : `«${v.name}» re-read.`);
    $('status').className = still.length ? 'warn' : 'ok';
    render(); await openDetail(id);
  } catch (e) {
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    setBusy(false, interrupted
      ? `Could not finish writing «${v.name}». The mirror is blocked because its files describe two different moments - run Pull all to repair it.`
      : `Could not re-read «${v.name}»: ` + friendlyError(e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
    noteThrown(e);   // what the report will be about, if they press the button it just showed
  } finally { setPullBusy(false); }
}

async function retryFailed() {
  if (pullBusy) return;
  const op = beginWorkspaceOp();   // the workspace these items belong to
  if (mismatchRefuse()) return;
  const ids = [...new Set(pullFailed.map((f) => f.id))];
  if (!ids.length) return;
  const onProgress = (m) => { if (m?.type === 'pullProgress') op.say(`Retrying ${m.stage}… ${m.done} / ${m.total}`, 'busy'); };
  chrome.runtime.onMessage.addListener(onProgress);
  setPullBusy(true);
  setBusy(true, `Retrying ${ids.length} item(s)…`);
  try {
    await requirePerm(op.root);
    const nextSqls = { ...sqls };
    const nextDeps = { ...(deps || {}) };
    const qIds = ids.filter((i) => { const v = viewById().get(i); return v && v.type === 'QueryTable'; });
    const still = [];
    if (qIds.length) {
      const r = await toBridge({ cmd: 'pullSql', ids: qIds });
      // The sibling branch below said `return endBusyElsewhere()` and this one said `return`, so a
      // switch during the SQL half left Pull, Refresh, export, the diagram, Health and the assistant
      // disabled until the panel was reopened. The `finally` removes the listener and knows nothing
      // about `busy`.
      if (!op.current()) return endBusyElsewhere();
      Object.assign(nextSqls, r.sql || {});
      still.push(...(r.failed || []).map((f) => ({ ...f, stage: 'sql' })));
    }
    const r2 = await toBridge({ cmd: 'scanDependencies', ids });
    // Before the model is touched, not only before the disk is: these ids belong to the workspace
    // this retry started in, and merging them into another one's memory is the same defect indoors.
    if (!op.current()) return endBusyElsewhere();
    Object.assign(nextDeps, r2.deps || {}); still.push(...(r2.failed || []).map((f) => ({ ...f, stage: 'lineage' })));
    await writePartialSnapshot(op, { sqls: nextSqls, deps: nextDeps, pullFailed: still });
    if (!op.current()) return endBusyElsewhere();
    ({ sqls, deps, pullFailed } = { sqls: nextSqls, deps: nextDeps, pullFailed: still });
    mergeSchemaIntoViews();
    setBusy(false, pullFailed.length ? `${pullFailed.length} still unreadable.` : 'All previously failed items are now in.');
    $('status').className = pullFailed.length ? 'warn' : 'ok';
    render();
  } catch (e) {
    const interrupted = !!(e && e.mirrorIncomplete && op.current());
    if (interrupted) refuseIncompleteSnapshot();
    setBusy(false, interrupted
      ? 'Retry could not finish writing. The mirror is blocked because its files describe two different moments - run Pull all to repair it.'
      : 'Retry failed: ' + friendlyError(e)); $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
    noteThrown(e);   // what the report will be about, if they press the button it just showed
  } finally { chrome.runtime.onMessage.removeListener(onProgress); setPullBusy(false); }
}

// Split out so a single-item refresh rewrites only what it touched, instead of the whole mirror.
async function writeLineage(op, nextDeps = deps, nextFailed = pullFailed) {
  if (!op || !op.current()) return;
  await writeJson('lineage.json', { workspace: bound && bound.workspace, deps: nextDeps, failed: nextFailed }, op);
}
async function writeSql(op, nextSqls = sqls) {
  if (!op || !op.current()) return;
  let unreadable = null;
  const index = await readJson('sql/index.json', {}, op, (failure) => { unreadable = failure; });
  if (unreadable) throw new Error(`Could not read ${unreadable.rel} (${unreadable.name}).`);
  for (const [id, q] of Object.entries(nextSqls)) {
    if (typeof q.sql !== 'string') continue;              // not re-read this session; its file is current
    const v = viewById().get(id);
    const stem = q.stem || stemOf(v ? v.name : id, id);
    await op.write(`sql/${stem}.sql`, q.sql);
    index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
  }
  await writeJson('sql/index.json', index, op);
}

/** A one-view refresh still changes several files. Keep the old in-memory model until all of them
 *  are durable, and bracket the disk writes with the same marker as Pull all. If any write fails,
 *  loadFromDisk() and this live panel both refuse the hybrid instead of presenting it as a snapshot. */
async function writePartialSnapshot(op, next) {
  await op.write(PULL_STATE, JSON.stringify({ state: 'writing', startedAt: new Date().toISOString() }));
  try {
    await writeLineage(op, next.deps, next.pullFailed);
    await writeSql(op, next.sqls);
    await op.write(PULL_STATE, JSON.stringify({ state: 'complete', completedAt: new Date().toISOString() }));
  } catch (e) {
    try { e.mirrorIncomplete = true; } catch (_) {}
    throw e;
  }
}

/** Remove the .sql files the new index no longer names - a deleted query's file, and the old stem
 *  of a renamed one. Without this they accumulated silently, and once the index was replaced there
 *  was no map left to even say which were residue. Runs only after the new files and the new index
 *  are written; a removal that fails stays for the next pull, which derives the same keep-set and
 *  retries for free. */
async function pruneSql(index, op, census) {
  // **What the workspace has, not what this pull could read.** The keep-set was the new index alone,
  // and a query table is only in that index if its SQL came back *this time* - so a workspace where
  // 60 of 200 queries answered 429 lost 60 previously-good .sql files in one pull, in the folder the
  // reader keeps under git. «Could not be read» is not «no longer exists», and this is the one place
  // in the product where confusing them destroys something. Found by a review of this file, under
  // the fifth of the six questions: does partial data authorise a destructive act?
  //
  // The CRM twin has always drawn the line here - it prunes from the census `listFunctions` returns,
  // and refuses to prune at all when that list came back capped - and this is the same rule: a view
  // that is still a query table in the workspace keeps its file, whatever happened to it today. Its
  // *index row* is still absent, so nothing serves yesterday's SQL as if it were current: the panel
  // says «not read», which is true, and the file survives for the next pull and for the diff.
  // Required, and it used to carry `= []`. An empty default turns the whole argument above into a
  // suggestion: drop it at the one call site and the keep-set is the index alone again, which is the
  // data loss this parameter exists to prevent - proven by doing exactly that and watching every
  // test and every checker stay green. Refusing is the only safe direction: a prune that cannot say
  // what the workspace still has must not decide what it no longer has.
  if (!Array.isArray(census)) {
    throw new Error('pruneSql needs the census of query tables the workspace still has - without it '
                    + 'the keep-set is only what was read this time, and a query whose SQL failed '
                    + 'would lose its file.');
  }
  const keep = new Set(Object.values(index).map((e) => `sql/${e.stem}.sql`));
  for (const v of census) keep.add(`sql/${stemOf(v.name, v.id)}.sql`);
  // **And under any name it has ever had, which the id is the only stable record of.** The stem
  // carries the view's name, so the two lines above protect a query table under the name it has
  // *now*: rename it in Zoho, have that one SQL read fail, and the file sits on disk under the old
  // stem with nothing keeping it.
  //
  // The first fix for this took the previous `sql/index.json` and protected the stems in it - and
  // survived exactly one failed pull. `writeToDisk` overwrites that index with only what was read
  // this time, so the *second* failed pull has no record of the old name and deletes the only
  // capture. Reported from outside, reproduced here: two failed pulls after a rename, and the file
  // is gone. A retention rule must not depend on a mapping that the failing path overwrites.
  //
  // The id is a suffix of every SQL filename and never changes, so it is what the rule reads. A live
  // query whose SQL did not arrive this pull keeps every file carrying its id, whatever it was
  // called; the moment fresh SQL for that id *does* arrive, `keep` holds the new name and the old
  // ones are removed by the same pass. A query the workspace no longer has keeps nothing.
  const freshIds = new Set(Object.keys(index).map(String));
  const unreadLive = census.map((v) => String(v.id)).filter((id) => !freshIds.has(id)).map((id) => `-${id}.sql`);
  let failed = 0;
  for await (const p of walk(op.root)) {
    if (!/^sql\/[^/]+\.sql$/.test(p) || keep.has(p) || unreadLive.some((sfx) => p.endsWith(sfx))) continue;
    try { await op.remove(p); }
    catch (e) {
      if ((e && e.message) === WS_MOVED) throw e;
      failed++;
    }
  }
  if (failed) op.say(`${failed} old .sql file(s) could not be removed - the next pull will retry.`, 'warn');
  return failed;
}
async function writeToDisk(info, op, next) {
  // The snapshot arrives as an argument and the globals are untouched until every write has landed:
  // this used to read the globals, which pullAll had already replaced stage by stage.
  //
  // The marker brackets the writes. Five files written in sequence cannot be atomic on this API, so
  // the next best thing is a mirror that *knows* it is mid-write: `.pull-state.json` says `writing`
  // until the last byte is out, and a load that finds it still saying so refuses the snapshot
  // instead of presenting files from two different moments as one. An interrupted pull is repaired
  // by running Pull all again, and the message says exactly that.
  const { views, folders, schema, relations, sqls, deps, pullFailed } = next;
  // Everything below this line is disk, and disk was the one stage of a pull that said nothing. The
  // reading stages each announce themselves and count; then the last one closed with «Reading
  // lineage... 50 / 50» and that line sat there through three JSON files, one .sql per query table
  // and a prune - which on a real workspace is hundreds of writes and takes long enough to read as a
  // hang. Reported as: the process looks stuck, so show what else is going on. A stage that is silent
  // is indistinguishable from a stage that is stuck - which is a rule this repository already holds
  // for its own tools, and had not applied to the one place the panel spends the longest.
  op.say('Writing the mirror\u2026', 'busy');
  await op.write(PULL_STATE, JSON.stringify({ state: 'writing', startedAt: new Date().toISOString() }));
  try {
    await writeJson('views.json', { workspace: info.workspace, pulledAt: new Date().toISOString(), folders, views }, op);
    await writeJson('schema.json', { workspace: info.workspace, tables: schema, relations }, op);
    await writeJson('lineage.json', { workspace: info.workspace, deps, failed: pullFailed }, op);
    // One .sql per query table, so the workspace is diffable in git - that is the whole point of the
    // mirror. The index keeps the id-to-file mapping and the column-level lineage beside it.
    const index = {};
    // Counted like every reading stage, and for the same reason: one file per query table is the
    // longest thing this function does, and «0 / 240» moving is the difference between working and
    // hung. Said every ten so the line does not flicker on a small workspace.
    const total = Object.keys(sqls).length;
    let written = 0;
    for (const [id, q] of Object.entries(sqls)) {
      const v = views.find((x) => x.id === id);
      const stem = stemOf(v ? v.name : id, id);
      await op.write(`sql/${stem}.sql`, typeof q.sql === 'string' ? q.sql : '');
      index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
      if (++written % 10 === 0 || written === total) op.say(`Writing SQL files\u2026 ${written} / ${total}`, 'busy');
    }
    await writeJson('sql/index.json', index, op);
    op.say('Removing what the workspace no longer has\u2026', 'busy');
    next.cleanupFailed = await pruneSql(index, op, views.filter((v) => v.type === 'QueryTable'));
    op.say('Finishing the mirror\u2026', 'busy');
    await op.write(PULL_STATE, JSON.stringify({ state: 'complete', completedAt: new Date().toISOString() }));
  } catch (e) {
    // The marker was written successfully, so any failure from here to `complete` means the disk is
    // not a snapshot. Carry that fact to pullAll; an ordinary Error message cannot distinguish it
    // from an API failure that happened before the first byte was touched.
    try { e.mirrorIncomplete = true; } catch (_) {}
    throw e;
  }
  await patchCfg({
    workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV,
    lastPull: new Date().toISOString(),
    counts: { views: views.length, folders: folders.length, tables: Object.keys(schema).length, relations: relations.length, sql: Object.keys(sqls).length },
  }, op);
  // Read once, through the op, and asked again before publishing: this is the panel's memory of which
  // workspace it is showing. Reproduced as a binding half from each - `workspace: A, label: B` - by
  // switching during the last write, which is the shape a mirror can never recover from by itself.
  // The two reads were also two reads of the same file for two fields.
  const cfg = await readJson(CFG, {}, op);
  if (!op.current()) return false;
  bound = { workspace: info.workspace, name: info.name, origin: info.origin,
            label: cfg.label || '', sample: !!cfg.sample, lastPull: cfg.lastPull || null,
            sv: Number(cfg.sv || 0) };
  return true;
}

// Which workspace we are in, as a number that only moves forward. Same reason as the CRM panel: an
// operation captures it once and every effect after an `await` asks whether it is still where it
// started. Reported there and reproduced here - a re-read begun in one workspace wrote its lineage
// and its SQL into the next.
let wsGen = 0;

// Four files, read one after another, each resolved against whatever folder was current at that
// moment - and published into the globals as they arrived. Two selections overlapping produced a
// panel bound to one workspace, showing the other's view list, with the first one's schema: a state
// no single file on disk can explain and nothing on screen can reveal. One operation, one snapshot,
// one publication.
async function loadFromDisk(op = beginWorkspaceOp()) {
  // A mirror whose last full pull never finished is five files from two moments. The marker is the
  // only thing that can say so; without this check the loader presented the hybrid as one snapshot.
  const ps = await readJson(PULL_STATE, null, op);
  if (ps && ps.state === 'writing') {
    if (!op.current()) return false;
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; viewsPulledAt = null; pullFailed = [];
    diskUnreadable = null; diskUnreadableAll = [];
    pullInterrupted = true;
    render();
    // `render()` returns early for an empty list; controls from the previous workspace must not
    // remain enabled over a snapshot this loader has explicitly refused.
    updateButtons();
    status('The last pull was interrupted mid-write, so the files on disk describe two different moments - run Pull all to repair the mirror.', 'warn');
    return false;
  }
  let failed = null;
  // Every file that would not open, not the first one. What the reader is about to be told
  // depends on which ones are missing, and one of them standing for all of them is how a mirror
  // short by a single file came to load as though it were whole.
  const noteFailure = (f) => { failed = failed || f; (failedAll ||= []).push(f); };
  let failedAll = null;
  const readOne = (rel) => readJson(rel, null, op, noteFailure);
  const v = await readOne('views.json');
  viewsPulledAt = (v && v.pulledAt) || null;
  const s = await readOne('schema.json');
  const l = await readOne('lineage.json');
  const index = await readOne('sql/index.json');
  if (!op.current()) return false;
  views = (v && v.views) || []; folders = (v && v.folders) || [];
  schema = (s && s.tables) || {}; relations = (s && s.relations) || [];
  deps = l && l.deps ? l.deps : null; pullFailed = (l && l.failed) || [];
  sqls = {};
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
  // A refreshed mirror invalidates the SQL cache. Keep the words in the box, as before, but stop
  // interpreting them as SQL or as a pattern until the reader chooses that mode again.
  paintSearchControls(searchState.useNames(true));
  if (index) for (const [id, e] of Object.entries(index)) sqls[id] = { id, sql: null, stem: e.stem, parents: e.parents || [], sources: e.sources || {} };
  mergeSchemaIntoViews();
  // **A workspace that loaded some of its files is not a workspace that loaded.** This kept the
  // failure only when *nothing* opened - so a `schema.json` that would not parse, with the view
  // list intact, produced a panel reporting 0 tables, 0 columns and 0 relations, an assistant
  // answering «has no columns and no reachable source», a health audit listing 35 views as having
  // no structure, and two exports with empty chapters and no note. None of it true: the tables
  // are in Zoho and were pulled, and one local file will not open. Absence read off a mirror that
  // is silently short is the one thing this product must never state.
  diskUnreadable = (failedAll && failedAll.length) ? failedAll[0] : null;
  diskUnreadableAll = failedAll || [];
  pullInterrupted = false;
  // Another workspace on disk: the chain is dropped, because every step in it is a view id that
  // belongs to the one being left. This and the removal below are the only places that forget.
  selectedId = null; navClear(); $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  render();
  // And whether the schema that wrote it is the one this build reads - stated, not acted on: a mirror
  // from an older Zoost is still every fact it captured, and what to do about that is the reader's.
  // A load that is short says so on the line that reports it, and says it as a warning: this is the
  // only sentence between «one file would not open» and every surface below stating an absence.
  const shortBy = diskUnreadableAll.map((f) => f.rel).join(', ');
  if (views.length) status(`${views.length} views loaded from disk${v && v.pulledAt ? ' · pulled ' + v.pulledAt.slice(0, 10) : ''}`
    + `${mirrorIsOlderThanSchema() ? ' · written by an older Zoost - Pull all captures what this one reads' : ''}.`
    + (shortBy ? ` ${diskUnreadableAll.length} file(s) here would not open (${shortBy}) - what they hold is missing from every count below. Press ↻ Refresh, or Pull all to rewrite them.` : ''),
    shortBy ? 'warn' : '');
  return true;
}

// "Empty" and "unreadable" are different facts and were the same message: every surface wrote
// `body || 'could not be read'`, and an empty string is falsy. So a query Analytics returned empty -
// or one whose file was written empty by the bug above - was reported as never having been read,
// which sent the assistant off reconstructing SQL it could simply have been told was absent.
//   null  → the file is not there or could not be opened
//   ''    → Analytics answered with an empty query
const SQL_UNREADABLE = '(the .sql file could not be read - use Pull on this view to fetch it again)';
const SQL_EMPTY = '(Zoho Analytics returned this query table with no SQL text at all)';
const sqlText = (body) => (body == null ? SQL_UNREADABLE : (body.trim() ? body : SQL_EMPTY));

// SQL bodies are not held in memory after a reload - they are read from their file on demand, which
// is also what keeps a large workspace from sitting in the panel's heap.
async function sqlBodyOf(id, op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  const q = sqls[id];
  if (!q) return null;
  if (typeof q.sql === 'string') { sqlDiskUnread.delete(String(id)); return q.sql; }
  let body = null, failed = false;
  try { body = await op.read(`sql/${q.stem}.sql`); } catch (_) { failed = true; }
  if (!op.current() || sqls[id] !== q) return null;
  if (failed) sqlDiskUnread.add(String(id)); else sqlDiskUnread.delete(String(id));
  q.sql = body;
  return body;
}

/** Resolve the state that needs the file as well as the index. `sqlState()` can say that a query
 *  is represented in `sql/index.json`; only this asynchronous half can say that the represented
 *  `.sql` file still opens. Keeping the distinction in one helper prevents search, exports and the
 *  assistant from each inventing a different meaning for `q.sql === null`. */
async function sqlReadState(id, op = beginWorkspaceOp()) {
  const st = sqlState(id);
  // A disk error is an observation, not a permanent verdict: permissions, a cloud-backed folder or
  // an external repair may make the same file readable on the next request. Pull failures and a
  // genuinely absent index entry cannot be repaired by opening the old file, so only the former is
  // retried here.
  const retryDisk = st.kind === 'unread' && sqlDiskUnread.has(String(id)) && !!sqls[id];
  if (st.kind !== 'read' && !retryDisk) return st;
  const body = await sqlBodyOf(id, op);
  if (body == null) return { kind: 'unread', error: 'the .sql file could not be read' };
  return { kind: 'read', query: sqls[id], body };
}

// ---------- derived ----------
// A candidate, not a verdict. Analytics knows what its own views read from each other; it does not
// know about a shared link someone bookmarked, a scheduled export, an embedded report or an API
// consumer. Every surface says "candidate" for that reason.
function isOrphanCandidate(v) {
  if (!deps) return false;
  const d = deps[v.id];
  if (!d) return false;                        // unread → not claimed either way
  if (v.type === 'Dashboard') return false;    // a dashboard is consumed by people, not by views
  return d.children.length === 0 && d.dashboards.length === 0;
}
// The ER endpoint carries `lastModTime`, epoch milliseconds, which matched LAST_DESIGN_MODIFY on
// every one of the 135 objects it describes. It is copied onto the views so the Design column can
// sort - but only Tables and QueryTables have it. Presentation views still only have Zoho's
// localized text, which is shown verbatim and never parsed, so they sort last and the note says so.
function mergeSchemaIntoViews() {
  for (const v of views) {
    const t = schema[v.id];
    v.designModifiedAt = t ? t.designModifiedAt : null;
    v.system = t ? !!t.system : false;
  }
}

// Foreign keys, per column, derived from the ER model's links. Not inferred: the bridge resolves
// each link's column indices to names, and rebuilding "(A.col)=(B.col)" from the pair reproduces
// Zoho's own `relationstring` exactly, on every link in the workspace this was measured on.
//
//   out - this column points at another table  (the classic foreign key)
//   in  - another table's column points at this one
//
// Returned keyed by column name so the columns table can annotate a row without searching.
function foreignKeys(viewId) {
  const out = new Map(), inc = new Map();
  for (const r of relations) {
    if (r.source === viewId) {
      r.sourceColumns.forEach((c, i) => {
        if (!out.has(c)) out.set(c, []);
        out.get(c).push({ id: r.target, name: r.targetName, column: r.targetColumns[i] || r.targetColumns[0] || '' });
      });
    }
    if (r.target === viewId) {
      r.targetColumns.forEach((c, i) => {
        if (!inc.has(c)) inc.set(c, []);
        inc.get(c).push({ id: r.source, name: r.sourceName, column: r.sourceColumns[i] || r.sourceColumns[0] || '' });
      });
    }
  }
  return { out, inc };
}

// Every relation this view takes part in, either end. Relations are stored once, not per side.
const relationsOf = (id) => relations.filter((r) => r.source === id || r.target === id);

const viewById = () => { const m = new Map(); for (const v of views) m.set(v.id, v); return m; };
// A view we cannot resolve is shown by its id - which is at least true. Returning the raw
// `.name` was how `undefined` reached the diagram as if it were a table's name.
const nameOf = (id, m) => (m.get(id) && m.get(id).name) || String(id == null ? '?' : id);

// Walk PARENT_ID up to the first view that actually has columns. Only Tables and QueryTables carry
// structure; a Pivot or a Report is a presentation of one of them, sometimes several steps removed.
// Following the chain is what lets the panel answer "what is the structure of this report" instead
// of shrugging - and it costs nothing, because PARENT_ID is already in the view list.
// Returns the chain from the view down to the data-bearing root, or null if it dangles.
function structureChain(v, m) {
  const chain = []; const seen = new Set();
  let cur = v;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); chain.push(cur);
    if (schema[cur.id]) return chain;
    cur = cur.parent ? m.get(cur.parent) : null;
  }
  return null;               // no data source reachable - say so rather than showing an empty table
}

// ---------- render ----------
// From epoch milliseconds, formatted from *local* calendar parts. Going through toISOString() looked
// right and was wrong: it converts to UTC first, so anywhere east of Greenwich a local midnight
// lands on the previous day and every date silently reads one day early.
function shortDate(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// One line, not two rows of chips: the CRM made this call already and wrote down why - seven
// filters wrapped, and the list below needs the vertical space more than the filter does. The counts
// move into the option labels so nothing is lost by dropping the chips.
function renderTypeFilter() {
  const sel = $('typesel');
  if (!views.length) { sel.innerHTML = '<option value="">—</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const counts = new Map();
  for (const v of views) counts.set(v.type, (counts.get(v.type) || 0) + 1);
  const opts = [`<option value="">All (${views.length})</option>`];
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    opts.push(`<option value="${escA(t)}">${esc(t)} (${n})</option>`);
  });
  if (deps) opts.push(`<option value="${escA(ORPHANS)}">Nothing depends on (${views.filter(isOrphanCandidate).length})</option>`);
  sel.innerHTML = opts.join('');
  // A filter this workspace has no option for is dropped rather than kept invisibly. `typeFilter` is
  // module state and survives a change of workspace, which is right while the choice still applies -
  // «Table» means the same thing in both. It stops applying when the new workspace has none of that
  // type, or when its lineage was never pulled and «Nothing depends on» is not offered: the select
  // then falls to selectedIndex -1 and shows nothing, while `visibleViews()` goes on filtering. The
  // reader sees a full workspace collapsed to «No view matches» under a control showing no filter.
  if (typeFilter && ![...sel.options].some((o) => o.value === typeFilter)) typeFilter = null;
  sel.value = typeFilter || '';
}

// ---- searching inside the SQL ------------------------------------------------------------------
// `in: names` looks at what the list already shows - name, folder, column names. `in: SQL` looks
// inside the queries themselves, which is what «search across every query at once» has always meant
// to a reader and what this panel could not do: the text is not in memory, it is read per view when
// you open one. So the first search of a session reads every .sql file once and keeps it.
const searchState = createSearchState({ scope: 'views', fullTextScope: 'views', fullTextMode: 'sql' });
let sqlCache = null;            // Map(id -> text), built once per workspace
let sqlUnread = 0;              // files that would not open, reported rather than counted as misses
const sqlDiskUnread = new Set();// ids whose index entry exists but whose last .sql open failed
let _sqlSearchT = null;


// Where a pattern matches inside one text, as [start, end) pairs - the pure half of the detail
// highlighter, lifted alone by tests/slice.mjs. Zero-length matches are stepped over, the same
// guard as everywhere else a user pattern runs.
function matchSpans(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Paint every match of the active full-text search inside `root`, through the CSS Custom Highlight
// API: ranges over the rendered text nodes, no DOM mutation - so the syntax colouring underneath is
// untouched, and a match that crosses its token boundaries still paints whole. Byte-identical in
// both panels; the ::highlight(zoost-find) rule in each page gives the marks their colour.
function paintFindMarks(root, re) {
  if (!('highlights' in CSS)) return;   // without the API the search still works, unpainted
  CSS.highlights.delete('zoost-find');
  if (!root || !re) return;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ n, at: text.length }); text += n.nodeValue; }
  const spans = matchSpans(text, re);
  if (!spans.length) return;
  const ranges = [];
  let i = 0;
  for (const [a, b] of spans) {
    while (i + 1 < nodes.length && nodes[i + 1].at <= a) i++;
    let j = i;
    while (j + 1 < nodes.length && nodes[j + 1].at < b) j++;
    const r = new Range();
    r.setStart(nodes[i].n, a - nodes[i].at);
    r.setEnd(nodes[j].n, b - nodes[j].at);
    ranges.push(r);
  }
  CSS.highlights.set('zoost-find', new Highlight(...ranges));
}

// The active full-text search as a compiled pattern, or null when there is nothing to paint: name
// mode, an empty box, or a pattern that does not parse.
function findMarkRe() {
  const search = searchState.snapshot();
  if (search.mode !== 'sql') return null;
  const q = search.text.trim();
  if (!q) return null;
  if (!search.regex) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
  return rxCompile(q).re || null;
}

// The search text as a pattern, or the reason it is not one. Case-insensitive like the plain
// search, and `m` so ^ and $ mean "at a line edge", which is what a reader of code or SQL expects.
// A declaration rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone, and
// byte-identical in both panels: a test holds the twins to the same source.
function rxCompile(term) {
  try { return { re: new RegExp(term, 'gim') }; } catch (e) { return { error: String((e && e.message) || e) }; }
}

// One line with every match wrapped in <mark>, escaped piece by piece - escaping first and then
// matching the escaped text would miss any pattern that touches `<` or `&`. A zero-length match is
// stepped over rather than marked: `x*` matches the empty string everywhere, and the escaper is a
// parameter because the two panels name theirs differently.
function markLine(line, re, escFn) {
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex > line.length) break; continue; }
    out += escFn(line.slice(last, m.index)) + '<mark>' + escFn(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escFn(line.slice(last));
}

// What a term does inside one query: how many times, and the first line it is on. A declaration
// rather than an arrow because `tests/slice.mjs` lifts it out and runs it alone.
function sqlHit(text, term, re) {
  if (!text || !term) return null;
  if (re) {
    re.lastIndex = 0;
    let count = 0, first = -1, m2;
    while ((m2 = re.exec(text))) {
      if (!m2[0]) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
      if (first < 0) first = m2.index;
      count++;
    }
    // A pattern whose only matches are empty matches nothing: there is no text to show a reader.
    if (first < 0) return null;
    const s2 = text.lastIndexOf('\n', first) + 1;
    let e2 = text.indexOf('\n', first);
    if (e2 < 0) e2 = text.length;
    return { count, line: text.slice(s2, e2).trim().slice(0, 160), lineNo: text.slice(0, first).split('\n').length };
  }
  const lc = text.toLowerCase(), t = term.toLowerCase();
  let idx = lc.indexOf(t);
  if (idx < 0) return null;
  let count = 0, i = idx;
  while (i >= 0) { count++; i = lc.indexOf(t, i + t.length); }
  const start = text.lastIndexOf('\n', idx) + 1;
  let end = text.indexOf('\n', idx);
  if (end < 0) end = text.length;
  return { count, line: text.slice(start, end).trim().slice(0, 160), lineNo: text.slice(0, idx).split('\n').length };
}

// Read every query's file once. A view whose file will not open is counted, never silently dropped:
// «no match» and «never read» are the distinction this panel exists to keep.
async function ensureSqlCache(op = beginWorkspaceOp()) {
  if (!op.current()) return null;
  if (sqlCache) return sqlCache;
  // A stem **or** a body already in memory. The stem is the name of the `.sql` file on disk and is
  // only needed to go and read one - which the loop below decides for itself, three lines down,
  // with `typeof q.sql === 'string'`.
  //
  // It was `q.stem` alone, and a pull publishes `sqls` straight from the bridge, whose answer has no
  // stem in it. So after every Pull all this filtered out **every** query, `entries` was empty, and
  // the search reported «no query matches» over queries it had never opened - while `sqlUnread`
  // stayed 0, because `sqlState` sees an entry and calls it read, so the "absence here is not
  // exhaustive" caveat was suppressed too. The one sentence written to stop this said the opposite.
  // Fixed by reopening the panel, which is why it survived: `loadFromDisk` puts the stems back.
  const entries = Object.entries(sqls).filter(([, q]) => q && (q.stem || typeof q.sql === 'string'));
  if (entries.length) op.say(`Reading the SQL of ${entries.length} quer${entries.length === 1 ? 'y' : 'ies'}\u2026`, 'busy');
  const m = new Map();
  const loaded = new Map();
  const readable = new Set();
  const failedOpen = new Map();
  // A query whose *pull* failed has no entry in `sqls` at all, so counting only files that refused
  // to open under-reported the gap: the search said «searched everything» over queries it never had.
  // Count structural/pull gaps here. Disk failures represented in `entries` are retried below and
  // counted exactly once only if that attempt fails too.
  let unread = views.filter((v) => v.type === 'QueryTable'
    && sqlState(v.id).kind === 'unread' && !sqlDiskUnread.has(String(v.id))).length;
  for (const [id, q] of entries) {
    // An explicit failed pull wins over an older indexed body: serving the old SQL as current would
    // turn a visible coverage gap into a plausible but stale answer.
    if (sqlState(id).kind === 'unread' && !sqlDiskUnread.has(String(id))) continue;
    if (typeof q.sql === 'string') { readable.add(String(id)); m.set(id, q.sql); continue; }
    try {
      const body = await op.read(`sql/${q.stem}.sql`);
      loaded.set(id, { q, body }); readable.add(String(id)); m.set(id, body);
    } catch (_) { failedOpen.set(String(id), q); unread++; }
  }
  if (!op.current()) return null;
  loaded.forEach(({ q, body }, id) => { if (sqls[id] === q) q.sql = body; });
  readable.forEach((id) => sqlDiskUnread.delete(id));
  failedOpen.forEach((q, id) => { if (sqls[id] === q) sqlDiskUnread.add(id); });
  sqlUnread = unread;
  sqlCache = m;
  if (entries.length) op.say(`${m.size} quer${m.size === 1 ? 'y' : 'ies'} read${sqlUnread ? ` \u00b7 ${sqlUnread} could not be opened` : ''}.`, sqlUnread ? 'warn' : '');
  return sqlCache;
}

function visibleViews() {
  return selectAnalyticsViews(views, {
    typeFilter,
    orphanToken: ORPHANS,
    search: searchState.snapshot(),
    schema,
    sqlCache,
    dependencies: deps,
    isOrphan: isOrphanCandidate,
    sortKey,
    sortDir,
    compileRegex: rxCompile,
    sqlMatches: sqlHit,
  });
}

/** Why the list is empty, in the order the states actually block each other.
 *
 * An empty state is never silent here: it says what is missing and what to do about it. Saying the
 * *wrong* missing thing is worse than silence, because the reader goes and does it and nothing
 * changes - which is what happened when a folder whose permission had lapsed was told to pick a
 * folder, create a workspace and pull.
 */
function emptyReason() {
  if (!root) {
    return '<b>No working folder yet.</b> Press <b>Sample</b> to try invented data, or use '
      + '<b>+ Workspace</b> from a Zoho Analytics tab. Either action asks for a dedicated folder and '
      + 'continues from there; every workspace lives inside it.';
  }
  if (!rootGranted) {
    // Deliberately no explanation of *why* the access is missing: on a first install nothing expired,
    // it was never given, and a stated cause that may not apply is one the reader has to discount.
    return '<b>Folder access is not granted.</b> Press <b>\u{1F513} Grant access</b> above - or simply '
      + 'click anywhere in this panel, which does the same. One click, no folder picker.';
  }
  if (!wsList.length) {
    return '<b>No workspace here yet.</b> Open a Zoho Analytics workspace in the active tab - its URL '
      + 'looks like <code>/workspace/&lt;id&gt;</code> - then press <b>+ Workspace</b>. Or press '
      + '<b>+ Sample</b> to write one of invented data and look around first: it never contacts '
      + 'Zoho Analytics, and it is deleted like any other workspace.';
  }
  if (isSample()) {
    // A sample workspace is written by «+ Sample» and never pulled, so «Press Pull all» names a
    // control that is refused for it by design - the reader goes to press it, finds it grey, and
    // learns nothing. Reported on the Actions tab, which arrived after the sample generator did:
    // an older sample folder simply has no actions/ in it, and rewriting the sample is the only
    // thing that puts one there.
    return '<b>Nothing of this kind in the sample workspace.</b> It is invented data written by '
      + '<b>+ Sample</b> and never pulled, so <b>Pull all</b> does not apply to it. If this list '
      + 'should not be empty, the sample was written before this part existed: delete the workspace '
      + 'and press <b>+ Sample</b> again.';
  }
  // The mirror is there and is refused: `loadFromDisk` found `.pull-state.json` still saying
  // `writing`. Without this the list fell through to «Nothing pulled yet», which sends the reader to
  // press Pull all - right by accident - while telling them something false about their own folder.
  if (pullInterrupted) {
    return '<b>The last pull was interrupted while it was writing.</b> The files on disk describe two '
      + 'different moments, so nothing here is shown rather than a mixture of them. Press '
      + '<b>Pull all</b> to repair the mirror.';
  }
  if (diskUnreadable) {
    // The one state where the files are there and the panel cannot see them. Naming the file and what
    // the browser called it, because the cause is outside this extension - a folder that moved, a
    // drive that went offline, a permission that lapsed between sessions - and the reader is the only
    // one who can tell which.
    return '<b>This workspace is on disk and could not be read.</b> <code>' + esc(diskUnreadable.rel)
      + '</code> is there and the read failed (' + esc(diskUnreadable.name) + '). Press <b>\u21bb Refresh</b>. '
      + 'If it happens again, the folder may have moved, or the drive it lives on may be offline.';
  }
  return '<b>Nothing pulled yet.</b> Press <b>Pull all</b> to read this workspace into the folder: the '
    + 'view list, the columns of every table, the relations and the SQL of each query table.';
}

function render() {
  const search = searchState.snapshot();
  renderTypeFilter();
  const list = $('list');
  if (!views.length) {
    // "Nothing here" plus **the** reason, not a reason. Reciting the whole sequence while the only
    // thing in the way is a lapsed folder permission sends the reader to do four things when one
    // click would do - and it is the step they have already done that gets repeated at them.
    list.innerHTML = `<div class="empty">${emptyReason()}</div>`;
    return;
  }
  // The detail pane shows the same search: matches painted in the open SQL, cleared when the
  // search empties, changes mode or stops parsing - one call, because null clears.
  paintFindMarks(document.querySelector('#detail pre.sql'), findMarkRe());
  const rawQ = search.text.trim();
  if (search.mode === 'sql' && search.regex && rawQ) {
    const rxErr = rxCompile(rawQ).error;
    if (rxErr) {
      // «No matches» for a pattern that never ran would be the lie this panel exists to refuse.
      list.innerHTML = `<div class="empty"><b>The pattern does not parse.</b> ${esc(rxErr)}. Nothing was searched - fix the pattern or switch .* off.</div>`;
      return;
    }
  }
  const rows = visibleViews();
  if (!rows.length) {
    // Written for `in: names`, and it was the only one. In SQL mode all three of its statements were
    // wrong: column names are not searched (that is the other branch), only query tables can match so
    // `views.length` is not the denominator, and - the one that matters - it says nothing about the
    // .sql files that would not open. `sqlUnread` is computed carefully by `ensureSqlCache` and was
    // used in exactly one place, a status line the next message overwrites. So a reader whose
    // workspace has three unreadable queries was told the search covered everything, on the one
    // surface where «no matches» is the whole answer. The assistant one screen over carries its
    // coverage with the answer; this is the same fact, said in the same voice.
    const qts = views.filter((v) => v.type === 'QueryTable').length;
    const narrowing = typeFilter ? 'The type filter and the' : 'The';
    list.innerHTML = search.mode === 'sql'
      ? `<div class="empty"><b>No query matches.</b>
      ${narrowing} search box are narrowing ${qts} quer${qts === 1 ? 'y' : 'ies'} down to none;
      the other ${views.length - qts} view(s) have no SQL to search.
      ${sqlUnread ? `<b>${sqlUnread} of them could not be opened</b>, so absence here is not exhaustive. ` : ''}Clear the box to see them all again.</div>`
      : `<div class="empty"><b>No view matches.</b>
      ${narrowing} search box are narrowing ${views.length} views down to none.
      The search also looks inside column names. Clear it to see them all again.</div>`;
    return;
  }
  // The number is the answer's headline; clicking it opens the breakdown. Naming the same fact
  // "Used by" in the list and "Read by" in the detail is how a reader ends up unsure they are
  // looking at the same thing - so it is one name now, and one click away from its detail.
  const usedBy = (v) => {
    if (!deps) return '';
    const d = deps[v.id];
    if (!d) return '<span class="orphan" title="This view could not be read during the pull">?</span>';
    const n = d.children.length + d.dashboards.length;
    return n
      ? `<a class="fk" data-lin="${escA(v.id)}" title="Show what reads from it">${n}</a>`
      : '<span class="orphan">none</span>';
  };
  // Own columns plain; inherited ones marked, because attributing a parent's structure to a report
  // without saying so would be a quiet lie about whose columns those are.
  const m0 = viewById();
  const colCount = (v) => {
    if (schema[v.id]) return String(schema[v.id].columns.length);
    const chain = structureChain(v, m0);
    if (!chain) return '—';
    const src = chain[chain.length - 1];
    // In brackets, never with a glyph in front. `↳19` sat flush against the digits in a column of
    // numbers and read as «419» - a mark that changes how a number reads is worse than no mark, and
    // this one is in the one column where the reader is scanning figures. Brackets cannot be mistaken
    // for a digit, the muted colour still separates it from an own count, and the tooltip still names
    // the view the structure comes from.
    return `<span title="${escA('columns inherited from ' + src.name + ' - this view has none of its own')}" style="color:var(--muted)">(${schema[src.id].columns.length})</span>`;
  };
  // In SQL mode the row says where the term is, the way the CRM's search results do: the line, its
  // number, and how many times the term appears in that query.
  const hlRe = rawQ && search.mode === 'sql'
    ? (search.regex ? rxCompile(rawQ).re : new RegExp(rawQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim'))
    : null;
  const sqlLine = (v) => {
    if (search.mode !== 'sql' || !sqlCache || !hlRe) return '';
    const h = sqlHit(sqlCache.get(v.id), rawQ, search.regex ? hlRe : null);
    if (!h) return '';
    return `<div class="sqlhit"><span class="n">${h.lineNo}</span>${markLine(h.line, hlRe, esc)}`
      + (h.count > 1 ? ` <span class="n">\u00d7${h.count}</span>` : '') + '</div>';
  };
  list.innerHTML = `<table class="vtbl">
    <thead><tr>
      <th>View</th><th>Type</th><th class="num" title="Columns. A number in brackets is inherited: the view has none of its own, and the count is the view it is built on.">Cols</th>
      <th class="num" title="As Zoho words it, in your interface language - not sortable, see the note below">Design</th>
      <th class="num">Data</th>${deps ? '<th class="num" title="How many views read from it, plus the dashboards it appears on - the Lineage tab breaks the same figure down">Read by</th>' : ''}
    </tr></thead><tbody>${rows.map((v) => `<tr data-id="${escA(v.id)}"${v.id === selectedId ? ' class="sel"' : ''}>
      <td><div class="vname">${esc(v.name)}</div>${sqlLine(v)}<div class="vsub">${esc(v.folderName || '—')}${v.owner ? ' · ' + esc(v.owner) : ''}${v.system ? ' · <span class="sysflag" title="Zoho Analytics flags this as a system table - it came from a connected source, you did not build it">system</span>' : ''}</div></td>
      <td><span class="vtype">${esc(v.type)}</span></td>
      <td class="num">${colCount(v)}</td>
      ${v.designModifiedAt
        ? `<td class="num" title="${escA(v.designModifiedBy ? 'by ' + v.designModifiedBy : '')}">${esc(shortDate(v.designModifiedAt))}</td>`
        : `<td class="num verbatim" title="${escA('Zoho gives no machine-readable value for this one - shown as it sends it' + (v.designModifiedBy ? ', by ' + v.designModifiedBy : ''))}">${esc(v.designModifiedText || '—')}</td>`}
      <td class="num">${esc(shortDate(v.dataModifiedAt))}</td>
      ${deps ? `<td class="num">${usedBy(v)}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = () => {
      // A row opened from an SQL search opens on the SQL tab: that is where the match the reader
      // clicked for lives, painted. The same pattern as the lineage links one block down.
      if (search.mode === 'sql' && search.text.trim()) detailTab = 'sql';
      openDetail(tr.dataset.id);
    };
  });
  list.querySelectorAll('a.fk[data-lin]').forEach((a2) => {
    a2.onclick = (ev) => { ev.stopPropagation(); detailTab = 'lin'; openDetail(a2.dataset.lin); };
  });
}

// ---------- detail ----------
// Every time the pane shows something else, it shows it from the top. Without this the scrollbar
// stays where the previous item left it and the reader is looking at row 40 of a table they have
// never seen. Run twice - once now, once after layout - because content rendered on the next frame
// would otherwise restore the old offset. Straight from the CRM panel, which has always done it.
function resetDetailScroll() {
  const doIt = () => {
    const e = $('dbody'); if (e) { e.scrollTop = 0; e.scrollLeft = 0; }
    const d = $('detail');
    if (d) d.querySelectorAll('pre,table,[style*="overflow"]').forEach((x) => { x.scrollTop = 0; x.scrollLeft = 0; });
  };
  doIt(); requestAnimationFrame(doIt);
}

async function openDetail(id) {
  const mine = ++detailLoad;
  const op = beginWorkspaceOp();
  // After the guard, not before it. Selecting an id this workspace does not have left the panel
  // marked on a view that does not exist - no row lit, the previous item still in the pane, nothing
  // said - and `selectedId` then fed the assistant's CURRENT FOCUS. Every caller guards the id today,
  // so this is a trap rather than a live defect; it costs one line not to leave it armed.
  const v = viewById().get(id);
  if (!v) return;
  selectedId = id;
  // Every way in passes through here - a row click, an arrow key, a foreign key, a lineage entry -
  // so the history is complete without any of them knowing it exists. The kind is carried too, so
  // the chain reads «query table Funnel» rather than a bare name.
  navHere(id, v.name, v.type);
  $('detail').classList.add('show'); $('resizer').classList.add('show');
  $('dtitle').textContent = v.name;
  // A Zoho read, so it is worded and coloured like every other Zoho read: "Pull", .zbtn. The ↻ glyph
  // means "reload from disk / re-grant folder access" in the CRM panel and must keep meaning only
  // that here - a symbol that fetches from Zoho in one app and reads the disk in the other is worse
  // than no symbol.
  $('dpull').disabled = busy || !guardOk();
  $('dpull').title = guardOk()
    ? 'Pull - this view only, its SQL and its lineage; «Pull all» does every view'
    : 'The active tab is a different workspace, so nothing can be pulled';
  $('dpull').onclick = () => pullOne(v.id);
  // Focused ER, exactly as the CRM opens a module's relations: the window takes it from here and
  // the depth stays adjustable there.
  const chain = structureChain(v, viewById());
  const srcId = chain ? chain[chain.length - 1].id : null;
  // Two different «no»s, and they were one. A table can be in the diagram and take part in no
  // relation - then there is nothing to draw around it. A view can be absent from the diagram
  // altogether, because `schema` is built from the ER model Zoho Analytics returns and that model
  // does not carry every view: asking to centre on one of those opened an empty window, which is
  // what was reported. Neither is offered, and each says which it is.
  // Offered whenever the diagram contains the view, relations or not. «No relation» was treated as
  // «nothing to show» and the button was greyed out - but the entity is the answer: the window draws
  // it alone and says that nothing links to it, which is a finding rather than an absence. Reported
  // twice in one session: first as an empty sheet, then as a button that would not open it.
  const inDiagram = !!(srcId && schema[srcId]);
  $('dgraph').disabled = !inDiagram;
  $('dgraph').title = !srcId
    ? 'ER diagram - nothing here has a structure to draw'
    : !inDiagram
      ? 'ER diagram - this view is not in the ER model Zoho Analytics returns, so the diagram does not contain it'
      : relationsOf(srcId).length
        ? 'ER diagram - opened on this table, in its own window'
        : 'ER diagram - opened on this table; it takes part in no relation, so it is drawn on its own';
  $('dgraph').onclick = () => openSchemaGraph(srcId, 2);
  // Absent on a sample: there is no Zoho Analytics view behind invented data, and a button that
  // opens a 404 is worse than one that is not there. Everywhere else it is an address, so it works
  // whether or not the tab is on this workspace.
  const zurl = isSample() ? null : viewUrl(v.id);
  $('dzoho').style.display = zurl ? '' : 'none';
  // Through `goToZoho`, like every other way this panel takes the reader to Zoho. It opened a new
  // tab unconditionally - so from inside a suite shell «Open in Zoho» left the shell *and* the tab
  // the reader was in, while the CRM's own «Open in Zoho» has always moved the tab they are on.
  // Reported: «Analytics behaves differently from CRM». One of a set that did not do what its
  // siblings do, which is the miss this repository asks to be caught by diffing against them.
  $('dzoho').onclick = () => { if (zurl) goToZoho(zurl); };
  $('dtitle').title = `${v.type} · ${v.folderName || 'no folder'} · id ${v.id}`;
  // A tab that cannot say anything about this view is disabled, not shown and silently empty - and
  // it says which silence it is, in a title, the way the ER button beside it has always done.
  //
  // `!sqls[id]` was two different facts under one grey tab. A view that is not a query table has no
  // SQL and never will; a query table whose SQL the pull could not read *has* one, and this product
  // states that everywhere else - in the search coverage line, in both exports, in the assistant's
  // answers. Here it turned the tab off and said nothing, which is the reading of «not read» as
  // «does not exist» that the rest of the release removed. The tab stays on and the pane gives the
  // reason Zoho or the disk gave.
  const sqlSt = sqlState(id);
  $('tab_sql').disabled = sqlSt.kind === 'not-query';
  $('tab_sql').title = sqlSt.kind === 'not-query' ? 'SQL - only a query table has any'
    : sqlSt.kind === 'unread' ? `SQL - not read: ${sqlSt.error}`
      : 'SQL - the query this view is built from';
  const rels = relationsOf(id).length;
  $('tab_rel').disabled = !rels;
  $('tab_rel').title = rels ? `Relations - ${rels} foreign key(s)`
    : 'Relations - nothing in the ER model links to or from this view';
  $('tab_lin').disabled = !deps;
  $('tab_lin').title = deps ? 'Lineage - what this reads, and what reads it'
    : 'Lineage - not pulled for this workspace; use Pull above';
  if (detailTab === 'sql' && sqlSt.kind === 'not-query') detailTab = 'cols';
  if (detailTab === 'rel' && !rels) detailTab = 'cols';
  if (detailTab === 'lin' && !deps) detailTab = 'cols';
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === detailTab));
  await renderDetail(v, mine, op);
  if (!detailCurrent(mine, op)) return;
  resetDetailScroll();
  render();
  // And the list follows: opening a view from a foreign key or from the lineage marks its row, and a
  // mark nobody can see is not a selection. The twin's tree does the same thing when a call in the
  // code takes you to another function.
  const row = [...$('list').querySelectorAll('tr[data-id]')].find((r) => r.dataset.id === String(id));
  revealRow(row, $('list'), 'thead');
}

async function renderDetail(v, mine = detailLoad, op = beginWorkspaceOp()) {
  const body = $('dbody');
  const m = viewById();
  // Off unless this tab is showing code, decided once here rather than in each branch: it lingered
  // over the columns because only the SQL branch had an opinion about it - a control that is turned
  // on in one place and never off in the others.
  $('codecopy').style.display = 'none';
  if (detailTab === 'cols') {
    const chain = structureChain(v, m);
    if (!chain) {
      body.innerHTML = `<div class="dpad"><div class="empty" style="padding:0"><b>No structure to show.</b>
        A ${esc(v.type)} has no columns of its own, and Zoho Analytics does not tell us which view it is
        built on - so there is nothing here that would be true.</div></div>`;
      return;
    }
    const src = chain[chain.length - 1];
    const t = schema[src.id];
    // When the structure is inherited, say whose it is and through what - a column list attributed
    // to the wrong object is worse than no column list.
    const via = chain.length > 1
      ? `<div class="vsub" style="margin:0">Structure of <b>${esc(src.name)}</b> (${esc(t.kind)}), inherited through ${chain.slice(0, -1).map((c) => esc(c.name)).join(' → ')} → <b>${esc(src.name)}</b></div>`
      : '';
    const { out, inc } = foreignKeys(src.id);
    const anyFk = out.size || inc.size;
    const ref = (c) => {
      const bits = [];
      for (const f of out.get(c.name) || []) bits.push(`<a class="fk" data-go="${escA(f.id)}" title="${escA('Foreign key → ' + f.name + '.' + f.column)}">→ ${esc(f.name)}<span class="fkc">.${esc(f.column)}</span></a>`);
      for (const f of inc.get(c.name) || []) bits.push(`<a class="fk in" data-go="${escA(f.id)}" title="${escA(f.name + '.' + f.column + ' points here')}">← ${esc(f.name)}<span class="fkc">.${esc(f.column)}</span></a>`);
      return bits.join('<br>');
    };
    body.innerHTML = (via ? `<div class="dpad" style="padding-bottom:0">${via}</div>` : '')
      + `<table class="ctbl"><thead><tr><th>Column</th><th>Type</th>${anyFk ? '<th>References</th>' : ''}</tr></thead><tbody>${
        t.columns.map((c) => `<tr><td>${esc(c.name)}</td><td class="t">${esc(c.type)}</td>${anyFk ? `<td>${ref(c)}</td>` : ''}</tr>`).join('')
      }</tbody></table>`;
    // The links are real navigation, as the CRM's function cross-references are: they open the other
    // table's structure rather than merely naming it.
    body.querySelectorAll('a.fk[data-go]').forEach((a2) => { a2.onclick = () => openDetail(a2.dataset.go); });
    return;
  }
  if (detailTab === 'rel') {
    const rs = relationsOf(v.id);
    // Zoho's own `relationstring` is shown as it writes it - "(A.col)=(B.col)". Re-rendering the
    // join in our own words would be an interpretation, and the point here is the fact, not our
    // phrasing of it. The direction is stated because a lookup is not symmetric.
    body.innerHTML = '<div class="dpad">' + rs.map((r) => {
      const out = r.source === v.id;
      return `<div class="rel"><b>${esc(out ? '→ ' + r.targetName : '← ' + r.sourceName)}</b><br>${esc(r.relation)}</div>`;
    }).join('') + '</div>';
    return;
  }
  if (detailTab === 'sql') {
    // `sqlReadState`, not `sqlBodyOf`. The raw reader answers from `sqls[id].sql`, which is a string
    // for anything read this session or straight after a pull - so a query whose SQL failed *this
    // time* still had a body in memory, and this pane painted it, highlighted, with the copy button
    // on. Meanwhile the tab's own title said «not read: HTTP 429», the search said so, both exports
    // said so and the assistant refused to conclude anything. Six surfaces telling the truth and the
    // one showing the text serving yesterday's, with nothing marking it as old.
    //
    // `sqlReadState` is where that precedence already lives: «an explicit failed pull wins over an
    // older indexed body - serving the old SQL as current would turn a visible coverage gap into a
    // plausible but stale answer». It was written and then not asked here.
    const st = await sqlReadState(v.id, op);
    const sql = st.kind === 'read' ? st.body : null;
    if (!detailCurrent(mine, op)) return false;
    // Only where there is code to take: this is the one tab of the four that shows any.
    $('codecopy').style.display = (sql && sql.trim()) ? '' : 'none';
    body.innerHTML = '<div class="dpad">' + (sql && sql.trim()
      // Highlighted, and still escaped: `highlightSql` tokenises the raw text and escapes every
      // piece itself, which is the only reason it may be handed to innerHTML at all.
      ? `<pre class="sql">${window.highlightSql ? window.highlightSql(sql) : esc(sql)}</pre>`
      // The reason, not a reason: `sqlState` knows whether the pull failed (and what Zoho said),
      // whether the file refused to open, or whether the mirror never had it. A single «could not be
      // read» over all three sends the reader to fix the wrong thing.
      : `<div class="empty" style="padding:0"><b>${sql == null ? 'The SQL was not read.' : 'No SQL text.'}</b> ${esc(sql == null ? st.error || SQL_UNREADABLE : sqlText(sql))}</div>`) + '</div>';
    paintFindMarks(body.querySelector('pre.sql'), findMarkRe());
    return;
  }
  // lineage
  const d = deps ? deps[v.id] : null;
  if (!d) { body.innerHTML = '<div class="dpad"><div class="empty" style="padding:0"><b>No lineage for this view.</b> Use Pull above to fetch just this one.</div></div>'; return; }
  // Every name that is a view in this workspace is a link to it - what reads from this, what it
  // reads, the dashboards it appears on. The Relations tab has worked this way since it was written
  // and the lineage did not, so the one box that answers «what depends on this» could not take you
  // to any of it. A name the panel cannot open stays plain: a link that leads nowhere is worse than
  // text.
  const goTo = (id, label) => (m.has(String(id))
    ? `<a class="fk" data-go="${escA(String(id))}" title="Open ${escA(label)}">${esc(label)}</a>`
    : esc(label));
  const li = (arr) => arr.length
    ? `<ul>${arr.map((x) => `<li>${goTo(x.id, nameOf(x.id, m))} <span class="lv">level ${x.level}</span></li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const dash = d.dashboards.length
    ? `<ul>${d.dashboards.map((x) => `<li>${goTo(x, nameOf(x, m))}</li>`).join('')}</ul>`
    : '<div class="none">none</div>';
  const q = sqls[v.id];
  const _sqlSt = await sqlReadState(v.id, op);
  const cols = q && q.sources
    // `s.columns` rather than `s.columns.length` straight: a pull always writes the list, and a
    // detail pane that throws half-drawn is not the place to find out that something did not. The
    // count is omitted rather than shown as zero - «0 columns involved» is a measurement, and this
    // would be the absence of one.
    ? Object.entries(q.sources).map(([tid, s]) => `<li>${goTo(tid, (s && s.name) || nameOf(tid, m))}${s && Array.isArray(s.columns) ? ` <span class="lv">${s.columns.length} columns involved</span>` : ''}</li>`).join('')
    : '';
  body.innerHTML = '<div class="dpad">'
    + `<div class="lin"><h5>Reads from</h5>${li(d.parents)}</div>`
    + `<div class="lin"><h5>Read by <span class="lv">- the same count the list shows</span></h5>${li(d.children)}</div>`
    + `<div class="lin"><h5>On dashboards</h5>${dash}</div>`
    + (cols ? `<div class="lin"><h5>Source columns involved</h5><ul>${cols}</ul></div>` : '')
    + (_sqlSt.kind === 'unread' ? `<div class="lin"><h5>SQL</h5><div class="none">not read - ${esc(_sqlSt.error)}. Retry failed / Pull all fetches it.</div></div>` : '')
    + '</div>';
  // Wired like the Relations tab's: naming a view and not taking you to it is the half a reader
  // notices. Reported for this box, in its general form - it should read like any hypertext.
  body.querySelectorAll('a.fk[data-go]').forEach((a2) => { a2.onclick = () => openDetail(a2.dataset.go); });
}

// Local only. Re-reads the mirror from disk, or takes the chance to re-grant a lapsed folder
// permission - it never talks to Zoho. Same meaning, same glyph and same title as the CRM panel's.
async function refreshLocal() {
  if (root && !rootGranted) { await grantRoot(); return; }
  if (!dir) return;
  setBusy(true, 'Reloading from disk…');
  // `loadFromDisk` returns false when it has *already* said why, and the one case that matters is a
  // mirror whose last pull was interrupted mid-write: it is refused, with the repair named. This was
  // the only caller that ignored the answer, so `setBusy(false)` wrote «Ready.» over the warning -
  // and the empty list underneath then blamed «Nothing pulled yet. Press Pull all», because the
  // writing branch returns before `diskUnreadable` is assigned. A blocked mirror, reported as an
  // empty one, under the word Ready.
  const ok = await loadFromDisk();
  setBusy(false, ok ? undefined : null);
}

// ---------- schema graph ----------
// The graph window is the CRM one, unchanged in its engine: same ER layout with the concentric and
// force branches, the same depth control and the same layout sliders. It consumes a generic
// node/edge shape, so the job here is to express the Analytics workspace in that shape rather than
// to write a second diagram - which is also why the two windows behave identically for anyone who
// uses both.
//
//   node   = a table or query table          (the only things with columns)
//   field  = a column, `lookup` set when it is a foreign key
//   edge   = a relation from the ER model
//   joins  = the same relations with Zoho's own join string, for the edge card and the table
//   reads  = the views that read from this table, from the lineage
function buildSchemaGraph() {
  const m = viewById();
  const nodes = {};
  for (const [id, t] of Object.entries(schema)) {
    const { out, inc } = foreignKeys(id);
    const joins = [];
    for (const [col, list] of out) for (const f of list) joins.push({ direction: 'out', other: f.id, otherName: f.name, column: col, otherColumn: f.column, relation: (relations.find((r) => r.source === id && r.target === f.id && r.sourceColumns.includes(col)) || {}).relation || '' });
    for (const [col, list] of inc) for (const f of list) joins.push({ direction: 'in', other: f.id, otherName: f.name, column: col, otherColumn: f.column, relation: (relations.find((r) => r.target === id && r.source === f.id && r.targetColumns.includes(col)) || {}).relation || '' });
    // Which views read from this table, so the diagram can answer "what breaks if I change it".
    const d = deps && deps[id];
    const reads = d ? d.children.map((x) => nameOf(x.id, m)) : [];
    nodes[id] = {
      id, name: t.name, api_name: t.name, display_name: t.name,
      namespace: t.kind === 'QueryTable' ? 'query' : 'table',
      system: !!t.system, category: t.kind, description: t.description || '',
      calls: [], called_by: [], rest: false, dead_suspect: false, unresolved: [], ambiguous: [],
      associated_place: null, file: null, source_code: '', params: [], return_type: null,
      fields: t.columns.map((c) => {
        const fk = (out.get(c.name) || [])[0];
        return { api_name: c.name, label: c.name, data_type: c.type, mandatory: false, lookup: fk ? fk.id : null };
      }),
      joins, reads,
      layouts: [], related_lists: [], layoutDetail: false, touched_by: [],
    };
  }
  const edgeSet = new Set();
  for (const r of relations) {
    if (!nodes[r.source] || !nodes[r.target] || r.source === r.target) continue;
    nodes[r.source].calls.push(r.target); nodes[r.target].called_by.push(r.source);
    edgeSet.add(r.source + '\u0000' + r.target);
  }
  Object.values(nodes).forEach((n) => {
    n.calls = [...new Set(n.calls)]; n.called_by = [...new Set(n.called_by)];
    n.dead_suspect = n.calls.length === 0 && n.called_by.length === 0;   // in no relation at all
  });
  const edges = [...edgeSet].map((e) => { const [a2, b2] = e.split('\u0000'); return [a2, b2]; });
  return {
    kind: 'schema', nodes, edges, focus: null, depth: null,
    counts: { nodes: Object.keys(nodes).length, edges: edges.length, dead_suspects: Object.values(nodes).filter((n) => n.dead_suspect).length, unresolved: 0 },
    // `label` travels too: without it the window has nothing to show and falls back to the derived
    // name, which is exactly the case the label exists for - Zoho Analytics calls the first
    // workspace of every account the same thing.
    // `idWord` because the header is drawn by a file both products share: the number below is a
    // workspace id, and without this the window called it an org - the other product's noun.
    workspace: { idWord: 'workspace', instance: bound ? (bound.name || bound.workspace) : null, org: bound ? bound.workspace : null,
                 label: (bound && bound.label) || null },
  };
}

// What the diagram window is given, which is less than what the panel holds. **This product's graph
// nodes never carry source at all** - a workspace has views, columns and relations, and the `''` the
// node builder writes is a shape the two products share, not a value. The sentence here used to be
// the other product's, copied whole: it told the next reader that Deluge sits in memory and is
// stripped at this line, which is a claim about a data flow that does not exist. A privacy comment is
// part of the security model, so it says what is true and nothing more.
//
// The strip stays, and it is the point of this function: the payload crosses into storage, and a
// field added to a node tomorrow has to be admitted here deliberately rather than arriving by
// default. It is a filter on the boundary, not a remedy for something known to be in the payload.
//
// And it goes to `chrome.storage.session`: this is a hand-off to a window opening in a moment, not a
// setting. Session storage is memory - it goes when the browser does, instead of a copy of the org's
// structure resting on disk until the next diagram replaces it.
/** Hand a graph to its own window: one key per window, not one slot for all of them - see the CRM
 *  twin for the race this closes. The identity is stamped by buildSchemaGraph() itself, which is
 *  synchronous and runs at the entry - so unlike the CRM there is no second photograph to take;
 *  what the op guards here is the two awaits between the build and the window. Returns false when
 *  the workspace moved before the window opened. */
async function publishGraph(g, op) {
  const token = crypto.randomUUID();
  const key = 'graphData:' + token;
  if (op && !op.current()) return false;
  await chrome.storage.session.set({ [key]: graphForWindow(g) });
  if (op && !op.current()) { try { await chrome.storage.session.remove(key); } catch (_) {} return false; }
  // A window that cannot open leaves nobody to consume the key, so it goes at once - otherwise the
  // payload sat in session storage until the browser closed, which is longer than the privacy page
  // is allowed to promise.
  try { await chrome.windows.create({ url: chrome.runtime.getURL('graphview.html?graph=' + token), type: 'normal', width: 1240, height: 840 }); }
  catch (e) { try { await chrome.storage.session.remove(key); } catch (_) {} throw e; }
  return true;
}
function graphForWindow(g) {
  const out = Object.assign({}, g, { nodes: {} });
  for (const [id, n] of Object.entries(g.nodes || {})) {
    const copy = Object.assign({}, n);
    delete copy.source_code;
    out.nodes[id] = copy;
  }
  return out;
}

async function openSchemaGraph(focusId, depth) {
  const op = beginWorkspaceOp();
  try {
    if (!Object.keys(schema).length) throw new Error('nothing pulled yet - run Pull all first');
    const g = buildSchemaGraph();
    if (!g.counts.nodes) throw new Error('no tables in this workspace');
    if (focusId && g.nodes[focusId]) { g.focus = focusId; g.depth = Math.max(1, depth || 2); }
    // The name travels with the id, because the window can only report what it was handed: asked to
    // centre on a view the diagram does not contain, it would otherwise have to name a number.
    else if (focusId) { g.focus = focusId; g.focusName = nameOf(focusId, viewById()); }
    if (!(await publishGraph(g, op))) return;
    status(`Schema: ${g.counts.nodes} tables, ${g.counts.edges} relations.`, 'ok');
  } catch (e) { status('Schema graph error: ' + (e.message || e), 'bad'); }
}

// ---------- about ----------
// The same dialog the CRM panel shows, with the same sections in the same order. A user who has both
// should recognise it immediately; that is the whole point of keeping them twins.
function showAbout() {
  const m = chrome.runtime.getManifest();
  $('aboutbody').innerHTML =
    `<div><b>${esc(PRODUCT_NAME)}</b> · v${esc(m.version)}</div>`
    + `<div style="color:var(--muted)">Created by ${esc(PRODUCT_AUTHOR)} (with the support of Claudio)</div>`
    + `<h4>Links</h4><div><a href="${escA(PRODUCT_URL)}" target="_blank" rel="noopener">zoost.it</a> · <a href="${escA(PAGE_URL)}" target="_blank" rel="noopener">What it does</a> · <a href="${escA(DOCS_URL)}" target="_blank" rel="noopener">How to use</a> · <a href="${escA(PRODUCT_URL)}/privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="${escA(STORE_URL)}" target="_blank" rel="noopener">Web Store</a> · <a href="${escA(REPO_URL)}" target="_blank" rel="noopener">Source</a> · <a href="mailto:${escA(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></div>`
    + `<h4>Support</h4><div><a href="${escA(SPONSOR_URL)}" target="_blank" rel="noopener">GitHub Sponsors</a> · <a href="${escA(KOFI_URL)}" target="_blank" rel="noopener">☕ Ko-fi</a></div>`
    + `<h4>Licence</h4><div><a href="${escA(LICENSE_URL)}" target="_blank" rel="noopener">${esc(PRODUCT_LICENSE)}</a> · © 2026 ${esc(PRODUCT_AUTHOR)}</div>`
    + `<h4>Legal</h4><div class="legal">${esc(LEGAL_DISCLAIMER)}</div>`
    + `<h4>Your data</h4><div class="legal">The mirror stays between your browser, your Zoho session and the local folder you picked. `
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the workspace it needs - the workspace's own name and its Zoho id, view names and what kind of view each is, the folder and description of a view, the name Zoho records as its owner, when its design and its data last changed, column names and their types, the relations between tables, what depends on what, and the SQL of your query tables - are sent directly from your browser to the provider you configured, and to no one else. `
    + `Rows are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine, except a problem report you write, read in full and send yourself.</div>`;
  $('scrim').classList.add('on'); panelInert(true); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); panelInert(false); $('aboutdlg').classList.remove('on'); }

// ---------- wiring ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept - in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
/** What to call a workspace on screen: the name its owner gave it, then the platform's, then its id.
 *
 *  The order is the point, and it was wrong wherever the *binding* was shown rather than the list. The
 *  mismatch bar said «this folder mirrors "Default Workspace" (99000001)» over a workspace the reader
 *  had named «Acme production» a minute earlier - the one word they would have recognised, dropped in
 *  the one sentence that exists to be recognised. Reported. The id stays beside it in the bar, because
 *  that is the fact nothing can be wrong about; here it is the last resort, not the subject. */
function wsShown(b) {
  if (!b) return '';
  // Two shapes reach here and both are «a workspace»: the binding this panel holds, which carries the
  // reader's own name as `label`, and a row of the workspace list, which carries it as `cfg.label`.
  // Reading only the first left «Switch workspace -> ...» naming the platform under a sentence that
  // had just stopped doing exactly that. Reported, after the first fix - and the test that held the
  // sentence stopped at the button, so it agreed with the bug.
  const own = ((b.label || (b.cfg && b.cfg.label) || '') + '').trim();
  return String(own || (b.name || '').trim() || b.workspace || b.id || '');
}
function wsOptionText(w) { return ((w.cfg && w.cfg.label) || '').trim() || `${w.name || w.folder} \u00b7 ${w.id}`; }
/** The workspace list is ordered by what the reader actually sees. Sorting by the derived name
 *  while displaying the user's own label produces a list that looks unsorted - «Acme» in a folder
 *  called «zzz-1234» lands at the end - and this bar is where a consultant with four clients open
 *  spends the day. Numeric, so «Client 2» comes before «Client 10»; base sensitivity, so case and
 *  accents do not split the order. */
function byWsLabel(a, b) { return wsOptionText(a).localeCompare(wsOptionText(b), undefined, { numeric: true, sensitivity: 'base' }); }
function wsOptionTitle(w) {
  const label = ((w.cfg && w.cfg.label) || '').trim();
  return label ? `${label} - folder ${`${w.name || w.folder} \u00b7 ${w.id}`}` : `${w.name || w.folder} \u00b7 ${w.id}`;
}

/** A name of the user's own for a workspace.
 *
 * The folder name is derived from the platform, and the platform is not always evocative: Zoho
 * Analytics names the first workspace of every account the same way, so three projects can arrive on
 * disk with the same label and nothing to tell them apart. Zoho CRM has the instance and the org id,
 * which are unambiguous and still not memorable.
 *
 * So the label is *displayed instead of* the derived name, and the derived name never disappears -
 * it stays in the option's tooltip and in the bar beneath, because the label is a convenience and the
 * identity is the org or workspace id. Storing it in `.zoost.json` (through `patchCfg`, never
 * `writeCfg`) keeps it with the workspace: it survives a re-pull, and it travels with the folder if
 * the folder does.
 */
async function renameWorkspace() {
  if (workspaceChangeRefuse()) return;
  const op = beginWorkspaceOp();   // the prompt and the permission both await; the folder can move
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !dir) return;
  const current = (w.cfg && w.cfg.label) || '';
  const typed = window.prompt(
    `Name for this workspace.\n\nShown in the list instead of \u00ab${w.name}\u00bb, which stays visible as the tooltip.\nLeave it empty to go back to that name.`,
    current);
  if (typed === null) return;                      // cancelled: not the same as cleared
  const label = typed.trim().slice(0, 60);         // it has to fit a 400px bar; longer is not a name
  if (label === current) return;
  try {
    // Chrome lets the folder permission lapse, and this writes to disk. Asked for here because here
    // there is a click to ask under: without it getFileHandle() throws the same bare "not allowed"
    // DOMException the AI path used to. Third time this shape has surfaced - a write reached from a
    // control is a write that must re-request first.
    if (!(await ensurePerm(op.root))) { status(MSG.folder, 'warn'); return; }
    if (!op.current()) return;
    await patchCfg({ label }, op);
    if (!op.current()) return;
    status(label ? `Workspace named \u00ab${label}\u00bb.` : 'Workspace name cleared - back to the folder name.', 'ok');
    await refreshWorkspaces();
  } catch (e) { if (op.current()) status('Could not save the name. ' + friendlyError(e), 'bad'); }
}
$('wsrename').onclick = renameWorkspace;
$('wsadd').onclick = addWorkspace;
$('wssample').onclick = () => addSampleWorkspace();
// The same action from the off-Zoho overlay, which is where somebody who has just installed
// Zoost and is not signed in to anything actually is.
// One call for both copies of the button: addSampleWorkspace() decides whether there is one to
// open or one to write, so the two cannot disagree and neither can act on a stale label.
$('offsample').onclick = () => addSampleWorkspace();
/** Write the sample workspace into the working folder, then open it.
 *
 * It goes through the same code every other workspace does - the files land on disk and the ordinary
 * list picks them up - so nothing downstream has to know it exists. `sample: true` in .zoost.json is
 * the whole mechanism.
 */
// Whether a sample workspace exists, kept where it can be read **without the folder handle**.
//
// This is the bug that took three reports to find, and the diagnosis was mine to make. Until the
// folder permission is granted, refreshWorkspaces() returns before it enumerates anything, so `wsList`
// is empty and the panel cannot tell a sample apart from no sample - it offered to create one that
// was sitting right there. Chrome drops that permission between sessions, so the state right after
// the panel opens is exactly the state where the question is asked.
//
// Same shape as `tabAccessView`, and for the same reason: a display-only copy of a fact, in
// chrome.storage.local, for a surface that cannot reach the folder. The folder stays the authority -
// this is only ever read into a label, and the *action* re-checks after granting.
let sampleWsKnown = null;
// Best-effort, and **declared** rather than wrapped in a `try` that cannot catch it: a synchronous
// try/catch around an un-awaited promise catches only a throw while the promise is being made,
// never its rejection. What is remembered here is a cache of a fact the folder already holds -
// `knownSample()` prefers the live workspace list and falls back to this - so losing it degrades
// to «not looked yet», which is a state the panel already draws honestly. Nothing to report.
// A declaration rather than a `.then(cb)`: the callback writes a module-level variable after an
// await, which is the one shape `tools/asynccheck.py` exists to look at - and inside a callback it
// could not look at it at all. Nothing guards it because nothing has to: the value is a cache of a
// fact the folder holds, and the startup read cannot be overtaken by anything that reads it.
async function readRememberedSample() {
  let v;
  try { v = await chrome.storage.local.get('sampleWs'); } catch (_) { return; }
  sampleWsKnown = (v && v.sampleWs) || null;
  updateSampleButtons();
}
void readRememberedSample();
function noteSampleWs(id) {
  sampleWsKnown = id || null;
  void chrome.storage.local.set({ sampleWs: sampleWsKnown }).catch(() => {});   // see the read above
}
/** The one the panel can act on, or - when the folder is not readable yet - the one it remembers. */
function knownSample() {
  const w = (wsList || []).find((x) => x.cfg && x.cfg.sample);
  return w || (sampleWsKnown ? { id: sampleWsKnown, remembered: true } : null);
}
/** Can the panel answer «is there a sample?» at all right now?
 *
 * Only if it has read the folder. Until the permission is granted the enumeration returns early, so
 * an empty list means «not looked», not «not there» - and the button was reading it as the second
 * and offering to create a sample that existed. Four reports.
 */
const sampleKnowable = () => !!(root && rootGranted) || !!sampleWsKnown;
function updateSampleButtons() {
  const view = sampleWorkspaceView(knownSample(), sampleKnowable(), pullBusy || sampleBusy);
  const sb = $('wssample');
  if (sb) {
    sb.hidden = false;
    sb.disabled = view.disabled;
    sb.textContent = view.buttonLabel;
    sb.title = view.title;
  }
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
    ob.disabled = view.disabled;
    // Three states, because «+» and «Open» are both claims and there is a moment when neither can be
    // made. `+` says «there is none» and `Open` says «there is one»; with the folder unread the
    // honest label asserts nothing and the tooltip says the click will find out. This project does
    // not state what it has not measured, and a button label is a statement like any other.
    ob.textContent = view.overlayLabel;
    ob.title = view.title;
  }
}

let sampleBusy = false;
async function openSampleWorkspace(have) {
  $('ws').value = have.id;
  $('offoverlay').classList.remove('show');
  return selectWorkspace(have);
}
async function createSampleWorkspace() {
  sampleBusy = true;
  // The overlay is opaque and covers the status line, so it comes down before the writing starts -
  // otherwise the progress is written where nobody can read it, which is what made pressing again
  // look like the reasonable thing to do.
  $('offoverlay').classList.remove('show');
  ['wssample', 'offsample'].forEach((b) => { const e = $(b); if (e) e.disabled = true; });
  try { await writeSampleWorkspace(); }
  finally {
    sampleBusy = false;
    updateSampleButtons();
  }
}
async function addSampleWorkspace() {
  if (sampleBusy) return;
  return runWorkspaceEntry({
    refuse: workspaceChangeRefuse,
    root: () => root,
    pickRoot,
    ensurePermission: ensurePerm,
    permissionRefused: () => status(MSG.folder, 'warn'),
    folderWasGranted: () => rootGranted,
    refreshAfterGrant: refreshWorkspaceEntryAfterGrant,
    context: () => true,
    contextMissing: () => {},
    findExisting: () => (wsList || []).find((w) => w.cfg && w.cfg.sample),
    openExisting: openSampleWorkspace,
    create: createSampleWorkspace,
  });
}
async function writeSampleWorkspace() {
  try {
    const gen = window.SAMPLE_ORG;
    if (!gen) { status('The sample generator is not loaded.', 'bad'); return; }
    const base = await appRoot(true);
    if (!base) { status(`Could not create the ${APP_DIR}/ folder inside the working folder.`, 'bad'); return; }
    const h = await base.getDirectoryHandle(gen.folderName(), { create: true });
    const files = gen.files({});
    const all = Object.entries(files);
    // Three hundred files through the File System Access API take long enough to look like a hang -
    // reported as exactly that. The count is what says it is working, so it is written often enough
    // to move and rarely enough not to be the cost itself.
    status(`Writing the sample workspace - 0 of ${all.length} files\u2026`, 'busy');
    for (let i = 0; i < all.length; i++) {
      const [rel, text] = all[i];
      const parts = rel.split('/');
      let d = h;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      if (i % 10 === 9 || i === all.length - 1) {
        status(`Writing the sample workspace - ${i + 1} of ${all.length} files \u00b7 ${rel.split('/')[0]}\u2026`, 'busy');
        await new Promise((r) => setTimeout(r, 0));   // let the status line actually paint
      }
    }
    status(`Sample workspace written - ${Object.keys(files).length} files in \u00ab${gen.folderName()}\u00bb. Nothing was fetched from Zoho Analytics.`, 'ok');
    await refreshWorkspaces();
    openOverview();
  } catch (e) { status('Could not write the sample: ' + e.message, 'bad'); }
}
$('wsdel').onclick = delWorkspace;
async function onWs() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (w) await selectWorkspace(w);
}
$('ws').onchange = onWs;
$('pull').onclick = pullAll;
// Touched by hand, so the next repaint leaves it alone: this control is redrawn on every
// workspace change, and a choice that is reset while you are looking at it is not a choice.
$('gozohodc').onchange = () => { $('gozohodc').dataset.touched = '1'; };
$('gozoho').onclick = openZohoHome;
// ---- keyboard: the selection follows the arrows ------------------------------------------------
// Up and down used to scroll the list, because that is what a browser does with a scrollable box.
// What a reader wants is the next view *open* - the same thing a click does - and the list is what
// the panel is for. Reported as missing.
//
// Only rows that are actually on screen take part: `visibleViews()` is what the filters and the
// search have left standing, and stepping onto something the reader has filtered away would be the
// list disagreeing with itself.
// Bring a row fully into view, under whatever is stuck to the top of the list. `scrollIntoView`
// with `block: 'nearest'` aligns to the container's edge and knows nothing about a sticky header -
// so stepping upwards parked the selected row exactly underneath it, half visible. Reported after
// the arrows landed: the movement was right and the row was not all there.
//
// The header is measured rather than assumed: it is a column row in one product and a group label
// in the other, both `position: sticky`, and both change height with the font a reader has set.
function revealRow(el, box, stickySel) {
  if (!el || !box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const st = stickySel ? box.querySelector(stickySel) : null;
  const cover = st ? st.getBoundingClientRect().height : 0;
  const top = b.top + cover;              // the first line the reader can actually see
  if (r.top < top) box.scrollTop -= (top - r.top);
  else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom);
}

function stepSelection(delta, edge) {
  const rows = visibleViews();
  if (!rows.length) return;
  let i;
  if (edge === 'first') i = 0;
  else if (edge === 'last') i = rows.length - 1;
  else {
    const at = rows.findIndex((v) => v.id === selectedId);
    // Nothing selected yet: down starts at the top, up at the bottom - the two ends a reader means.
    i = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
  }
  const v = rows[i];
  if (!v || v.id === selectedId) return;
  openDetail(v.id);
  // Walked rather than selected: an id in a selector wants CSS.escape, which reads like the HTML
  // escaping used everywhere else here and is a different thing - and the checker was right to ask
  // which. Comparing the dataset removes the question.
  const el = [...$('list').querySelectorAll('tr[data-id]')].find((r) => r.dataset.id === String(v.id));
  revealRow(el, $('list'), 'thead');
}

// ---------- history: the chain you have walked, and the way back up it ----------
// The twin of the CRM panel's, and the same argument: the lineage tab and the foreign keys made this
// a hypertext, and a hypertext you cannot come back through is a set of trapdoors. Back, forward,
// and the chain itself - «back» alone reaches the previous step and the author asked to be able to
// climb the whole thing.
//
// The handle is the view id, because that is what this panel opens everything by. `n` is a runtime
// identifier minted here: it keys the menu's rows, so the same view visited twice stays two steps of
// a walk rather than collapsing into one.
const NAV_MAX = 50;
const navHistory = createNavigationState(NAV_MAX);

function navHere(id, label, kind) {
  if (!id) return;
  const changed = navHistory.record(id,
    { id: String(id), label: label || String(id), kind: kind || '' });
  if (!changed) return;   // replay is an arrival on screen, not a new step in the walk
  updateNav();
}
function navClear() { navHistory.clear(); closeNavMenu(); updateNav(); }

/** Go to step `i`. The position moves even when the view has gone - a workspace can be pulled again
 *  with one fewer query in it - and the status line says so, the same as the twin. */
async function navTo(i) {
  const e = navHistory.startReplay(i);
  if (!e) return;
  navShow(false); updateNav();
  try {
    if (viewById().get(e.id)) await openDetail(e.id);
    else status(MSG.navGone, 'warn');
  } finally { navHistory.finishReplay(); }
}

function updateNav() {
  const state = navHistory.snapshot();
  $('dback').classList.toggle('show', state.canBack);
  $('dfwd').classList.toggle('show', state.canForward);
  $('navtab').style.display = state.entries.length ? '' : 'none';   // nowhere to go, nothing to offer
}
// When a step was taken. A real fact rather than something to fill a row with: with a chain that
// spans a session, «which of these two did I look at first» is a question the reader actually has,
// and the panel is the only thing that knows. Today's steps show the time alone - the date would be
// noise on every row - and anything older carries its day.
function navWhen(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    && d.getFullYear() === today.getFullYear();
  return sameDay ? t : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${t}`;
}
function closeNavMenu() { navShow(false); }
const navOpenNow = () => $('navview').classList.contains('show');
// Copy the code that is on screen. `textContent` rather than the source variable: what the reader is
// looking at is what lands in the clipboard, and the highlighting comes back off by itself. The mark
// becomes a tick for a moment, because a copy that says nothing is indistinguishable from a click
// that missed.
const COPY_MARK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V10a1.5 1.5 0 0 0 1.5 1.5h1.5"/></svg>';
const COPY_TICK = '<svg class="mk" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
async function copyCode(text) {
  const btn = $('codecopy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = COPY_TICK;
    setTimeout(() => { btn.innerHTML = COPY_MARK; }, 1200);
  } catch (e) {
    status(MSG.copyFailed + friendlyError(e), 'warn');
  }
}

function navShow(on) {
  $('navview').classList.toggle('show', on);
  // The same class the health and AI views set, driving the same rules: while this is up, every
  // other control in the toolbar is dimmed and inert. Three views of the workspace, one behaviour.
  document.body.classList.toggle('nav-open', on);
  const seg = $('navtab');
  if (seg) { seg.classList.toggle('on', on); seg.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (on) renderNav();
}
function toggleNavMenu() { navShow(!navOpenNow()); }
/** The chain, drawn full width. Newest first - the reader is looking for where they were a moment
 *  ago, not for where they started - and the step they are on is marked rather than left out. */
function renderNav() {
  const body = $('navbody');
  const state = navHistory.snapshot();
  const navHist = state.entries, navPos = state.position;
  // The same search box as the list it replaces - see the twin.
  const q = ($('navfind').value || '').trim().toLowerCase();
  const rows = navHist.map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || String(e.label).toLowerCase().includes(q) || String(e.kind || 'view').toLowerCase().includes(q));
  $('navcount').textContent = navHist.length
    ? `${rows.length === navHist.length ? navHist.length : rows.length + ' of ' + navHist.length} step${navHist.length > 1 ? 's' : ''}`
    : '';
  if (!navHist.length) {
    body.innerHTML = '<div class="nvnone">Nothing yet. Open a view and every step you take is '
      + 'listed here - click one to go back to it.</div>';
    return;
  }
  if (!rows.length) { body.innerHTML = `<div class="nvnone">${esc(MSG.narrowNav)}</div>`; return; }
  body.innerHTML = rows.map(({ e, i }) => `<div class="nvrow${i === navPos ? ' at' : ''}" data-n="${escA(String(e.n))}" data-i="${escA(String(i))}" title="${escA(String(e.id))}">`
    + `<span class="nvk">${esc(e.kind || 'view')}</span><span class="nvl">${esc(e.label)}</span>`
    + `<span class="nvw">${esc(navWhen(e.at))}</span></div>`).reverse().join('');
  body.querySelectorAll('.nvrow').forEach((r) => { r.onclick = () => navTo(Number(r.dataset.i)); });
}

// Emptying the chain does not close what is open: the reader asked to forget where they have been,
// not to lose the thing they are reading. The step they are on is kept as the only entry, so the
// next link still has something to come back to.
$('navclear').onclick = () => {
  navHistory.keepCurrent();
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('dback').onclick = () => navTo(navHistory.snapshot().position - 1);
$('dfwd').onclick = () => navTo(navHistory.snapshot().position + 1);
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode((document.querySelector('pre.sql') || {}).textContent || '');
$('navfind').oninput = renderNav;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  const at = navHistory.snapshot().position;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(at - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(at + 1); }
});

$('list').addEventListener('keydown', (e) => {
  // A field wants its own arrows - the search box is one line above this, and Tab reaches it.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const edge = { Home: 'first', End: 'last' }[e.key];
  if (!step && !edge) return;
  e.preventDefault();          // or the list scrolls under a selection that is already in view
  stepSelection(step || 0, edge);
});

function paintSearchControls(state = searchState.snapshot()) {
  const fullText = state.mode === 'sql';
  $('find').value = state.text;
  $('smode').textContent = fullText ? 'in: SQL' : 'in: names';
  $('smode').classList.toggle('on', fullText);
  $('find').placeholder = fullText ? 'Find inside the SQL\u2026' : 'Find\u2026';
  $('rxmode').classList.toggle('on', state.regex);
  $('rxmode').style.display = $('rxpick').style.display = fullText ? '' : 'none';
  if (!fullText) $('rxmenu').classList.remove('show');
}

$('find').oninput = () => {
  const search = searchState.setText($('find').value);
  // Debounced in SQL mode only: a user-authored pattern runs over every cached query body, and
  // doing that on each keystroke means doing it on the half-typed patterns too.
  if (search.mode === 'sql') { clearTimeout(_sqlSearchT); _sqlSearchT = setTimeout(render, 220); }
  else render();
};
async function onSmode() {
  const op = beginWorkspaceOp();
  // Leaving full-text with the pattern on takes the pattern with it, like the toggle going off:
  // a regex read as a name filter is a search for text that does not exist. Reported.
  const search = searchState.toggleMode();
  paintSearchControls(search);
  if (search.mode === 'sql' && !(await ensureSqlCache(op))) return;
  if (!op.current()) return;
  render();
}
$('smode').onclick = onSmode;
$('rxmode').onclick = () => {
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  paintSearchControls(searchState.toggleRegex());
  render();
};
// The saved patterns, offered where they are used. The background seeds the first two; the list
// itself lives in Settings, where it can be added to, edited and emptied; the menu reads it
// fresh on every open, and can append to it - its Save row, when there is a pattern to save.
async function loadRxShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    return Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string' && x.name && x.pattern)
      : [];
  } catch (_) { return null; }   // null, not []: a read that failed is not an empty list
}
/** Save the pattern in the box under a name, or say why it cannot be saved.
 *
 * A declaration rather than an `= async () => {}`, which is a scope the race checker cannot enter -
 * and there is an await in the middle of it. `items` is carried in rather than read again: it is the
 * list the menu was drawn from, and the whole point of the two checks above the write is that they
 * are about *that* list. Written the same way in the other product.
 */
async function saveSearchPattern(items, rawQ) {
  const name = $('rxsavename').value.trim();
  // The same rules the Settings page enforces, refused with the reason in place.
  if (!name) { $('rxsaveerr').textContent = 'A pattern needs a name.'; return; }
  if (items.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) {
    $('rxsaveerr').textContent = `"${name}" is already taken - the menu could not tell them apart.`;
    return;
  }
  const dupP = items.find((x) => x.pattern === rawQ);
  if (dupP) { $('rxsaveerr').textContent = `This pattern is already saved as "${dupP.name}".`; return; }
  try { await chrome.storage.local.set({ rxShortcuts: [...items, { name, pattern: rawQ }] }); }
  catch (_) { $('rxsaveerr').textContent = 'Could not write the list - try from Settings.'; return; }
  openRxMenu();   // re-read and redraw: the new entry appearing in the list is the confirmation
}

async function openRxMenu() {
  const menu = $('rxmenu');
  const list = await loadRxShortcuts();
  // The read yielded: the tab, the mode or the workspace may have moved meanwhile, and every one of
  // those hides the button. A menu for a control that is no longer there is not opened.
  if ($('rxpick').style.display === 'none') return;
  // Alphabetical by name, the way a reader scans a menu - storage order is append order, which
  // says when a pattern was saved and nothing else. The Settings list keeps storage order: rows
  // being edited must not reshuffle under the hands renaming them.
  const items = (list || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const search = searchState.snapshot();
  const rawQ = search.text.trim();
  // The save row exists only when there is something it could do: a pattern in the box that parses,
  // regex mode on, and a list that was actually read - saving over one that was not would overwrite
  // entries nobody has seen. A control that can do nothing goes away rather than sitting there.
  const savable = list !== null && search.regex && rawQ && !!rxCompile(rawQ).re;
  // A pattern already in the list is named, not re-offered: a second copy would be two menu
  // entries that search identically, and the name is how the reader finds the one they have.
  const already = savable ? items.find((x) => x.pattern === rawQ) : null;
  menu.innerHTML = items.map((x, i) => `<button data-rx="${escA(i)}"><span>${esc(x.name)}</span><span class="rxpat">${esc(x.pattern)}</span></button>`).join('')
    + (already ? `<div class="rxsave"><span class="rxnote">This pattern is already saved as "${esc(already.name)}".</span></div>`
      : savable ? `<div class="rxsave"><input id="rxsavename" placeholder="Name this pattern\u2026" maxlength="60" aria-label="Name for the pattern in the search box"><button data-save="1" title="Save the pattern in the search box under this name">Save</button><div class="rxerr" id="rxsaveerr"></div></div>` : '')
    + `<button class="rxman" data-man="1">${list === null ? 'The saved patterns could not be read. ' : (items.length ? '' : 'No saved patterns yet. ')}Manage\u2026</button>`;
  menu.querySelectorAll('[data-rx]').forEach((b) => {
    b.onclick = () => {
      menu.classList.remove('show');
      // The same guard as above, one interaction later: a pattern applied into a view whose search
      // no longer offers regex would filter names by a literal `\\b\\d{18}\\b`.
      if ($('rxpick').style.display === 'none') return;
      const x = items[+b.dataset.rx];
      paintSearchControls(searchState.usePattern(x.pattern));
      render();
    };
  });
  const sv = menu.querySelector('[data-save]');
  if (sv) {
    const doSave = () => saveSearchPattern(items, rawQ);
    sv.onclick = doSave;
    $('rxsavename').onkeydown = (e) => {
      // The panel's own shortcuts stay out of the input; Escape still bubbles to close the menu.
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter') doSave();
    };
  }
  menu.querySelector('[data-man]').onclick = () => { menu.classList.remove('show'); openSettings('#rx'); };
  const r = $('rxpick').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.classList.add('show');
}
$('rxpick').onclick = (ev) => {
  ev.stopPropagation();
  const menu = $('rxmenu');
  if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
  openRxMenu();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rxmenu') && !e.target.closest('#rxpick')) $('rxmenu').classList.remove('show');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('rxmenu').classList.remove('show'); });

$('findclear').onclick = () => { paintSearchControls(searchState.setText('')); render(); $('find').focus(); };
$('typesel').onchange = () => { typeFilter = $('typesel').value || null; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => { sortDir = -sortDir; $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;'; render(); };
$('overview').onclick = () => ($('overviewview').classList.contains('show') ? closeOverview() : openOverview());
$('overviewx').onclick = closeOverview;
$('graph').onclick = () => openSchemaGraph();
$('export').onclick = () => doExport('html');
$('exportmd').onclick = () => doExport('md');
$('retry').onclick = retryFailed;
$('refresh').onclick = refreshLocal;
$('health').onclick = () => ($('healthview').classList.contains('show') ? closeHealth() : (closeAI(), closeOverview(), openHealth()));
$('askai').onclick = toggleAI;
$('aix').onclick = closeAI;
$('aiclear').onclick = aiClear;
$('aigear').onclick = () => openSettings('#ai');
$('ainotex').onclick = () => $('ainote').classList.remove('show');
$('ailockgo').onclick = aiUnlock; $('ailockpass').onkeydown = (e) => { if (e.key === 'Enter') aiUnlock(); };
$('aisend').onclick = aiSend;
$('aiinput').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); aiSend(); } });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.aicfg) aiEngineChrome();
  if (ch.zohoDc) zohoDc = ch.zohoDc.newValue || zohoDc;
});
async function loadZohoDc() {
  try { const r = await chrome.storage.local.get('zohoDc'); if (r.zohoDc) zohoDc = r.zohoDc; } catch (_) {}
}
window.addEventListener('focus', () => aiEngineChrome());
$('healthx').onclick = closeHealth;
$('expx').onclick = () => closeScope(false);
$('expcancel').onclick = () => closeScope(false);
$('expgo').onclick = () => { scopeFromUI(); closeScope(true); };
// The presets set what the dialog holds, never the stored preference - see `dlgScope`.
// **A preset replaces the values, not the stamp.** `SCOPE_FULL` and `SCOPE_SAFE` carry no `sv`,
// so pressing one of them stored a scope that `loadScope` then read as «written before the
// default changed» and put through the one-shot migration again - every reload, for ever. The
// source-code tick chosen through «Everything» could never be remembered, while the same tick
// made by hand was. Settings has assigned onto the stored object since it was written.
$('pspFull').onclick = () => { dlgScope = Object.assign({}, dlgScope, SCOPE_FULL); scopeToUI(); };
$('pspSafe').onclick = () => { dlgScope = Object.assign({}, dlgScope, SCOPE_SAFE); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('opts').onclick = () => openSettings();
$('about').onclick = showAbout;
$('aboutx').onclick = closeAbout;
$('aboutok').onclick = closeAbout;
$('scrim').onclick = () => { closeAbout(); closeScope(false); };
// Closing the pane does not forget where you have been: reopening anything continues the chain.
$('dclose').onclick = () => { detailLoad++; $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; updateNav(); render(); };
document.querySelectorAll('.dtab').forEach((b) => {
  b.onclick = () => void showDetailTab(b);
});

/** Switch the detail pane to the tab that was clicked, and draw it for the selected view.
 *
 * A declaration rather than an `= async () => {}`: the checker cannot enter one, and this awaits a
 * render and then touches the scroll position - which belongs to whatever is selected by then, which
 * is why `mine` and `op` are taken before the await and asked about after it.
 */
async function showDetailTab(b) {
  if (b.disabled) return;
  const mine = ++detailLoad, op = beginWorkspaceOp();
  detailTab = b.dataset.tab;
  document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === b));
  const v = viewById().get(selectedId);
  if (v) { await renderDetail(v, mine, op); if (detailCurrent(mine, op)) resetDetailScroll(); }   // a different tab is different content too
}

// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
// Named, like every async scope this project ships: `tools/asynccheck.py` reads function
// declarations, so an inline callback is a scope nothing looks inside.
async function regrantOnAnyClick(e) {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await refreshWorkspaces(); } } catch (_) {}
}
document.addEventListener('click', regrantOnAnyClick, true);

// resizable split - the CRM's, down to the stored height
let dragY = false;
$('resizer').addEventListener('mousedown', () => { dragY = true; document.body.style.userSelect = 'none'; });
window.addEventListener('mousemove', (e) => {
  if (!dragY) return;
  const r = $('main').getBoundingClientRect();
  const h = Math.max(120, Math.min(r.height - 80, r.bottom - e.clientY));
  $('detail').style.height = h + 'px';
});
window.addEventListener('mouseup', () => {
  if (!dragY) return;
  dragY = false; document.body.style.userSelect = '';
  // Cosmetic, and best-effort by declaration - see the CRM twin's note on the same write.
  void chrome.storage.local.set({ detailH: $('detail').style.height }).catch(() => {});
});

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

/** Everything the panel has to read before it can draw itself, in the order it needs it.
 *
 * An async IIFE is a scope `tools/asynccheck.py` cannot enter, and this one is the whole startup:
 * four reads, each writing into the panel. A declaration, called on the next line.
 */
async function boot() {
  try { const r = await chrome.storage.local.get('detailH'); if (r && r.detailH) $('detail').style.height = r.detailH; } catch (_) {}
  await loadScope(); await loadZohoDc(); await restoreRoot(); await refreshContext();
}
void boot();
$('help').href = DOCS_URL;   // set here, not in the markup - same as the CRM panel

// What the report is allowed to know, gathered in one place so a reader can see the whole of it at
// once. Every value is a number, a boolean or one of a fixed set of words; the two free-text fields
// - the message and the stack - go through `redact()` inside buildReport. Nothing here reads the
// mirror, the sources, the SQL or any name.
function reportFacts(err, ai) {
  const m = chrome.runtime.getManifest();
  const ua = navigator.userAgent.match(/Chrome\/(\d+)/);
  const search = searchState.snapshot();
  return {
    product: m.name,
    version: m.version,
    browser: 'Chrome ' + (ua ? ua[1] : '?'),
    message: (err && (err.message || err)) || $('statustext').textContent,
    stack: (err && err.stack) || '',
    tab: 'views' + (detailTab ? '/' + detailTab : ''),
    search: search.mode === 'sql' ? (search.regex ? 'SQL, pattern' : 'SQL') : 'names',
    pullActive: !!pullBusy,
    sample: isSample(),
    counts: {
      views: (views || []).length,
      tables: Object.keys(schema || {}).length,
      queries: Object.keys(sqls || {}).length,
    },
    refused: [],
    ai,
    diag: (err && err.diag) || null,
    steps: reportSteps.slice(),
  };
}
// The last thing that actually threw. `openReport()` is opened from a button, so it has no error
// to hand - and without this the report was *only* the status buffer, which is the half that has to
// be redacted hardest and the half that says least. Two listeners, no call-site changes: an uncaught
// error and a rejected promise are exactly the failures worth a stack.
// **The sibling that was not walked.** The CRM learnt that `lastThrown` written by the two
// listeners alone describes only the failures nobody caught - and every failure this panel shows a
// report button for is caught by definition, that being why the button appears. Here it was left
// as it was, so a Zoho Analytics refusal produced a report with no message, no stack and no error
// class in it: the redacted status buffer and nothing else.
let lastThrown = null;
function noteThrown(e) { if (e instanceof Error) lastThrown = e; }
window.addEventListener('error', (e) => { if (e && e.error) lastThrown = e.error; });
window.addEventListener('unhandledrejection', (e) => { if (e && e.reason instanceof Error) lastThrown = e.reason; });
let reportText = '';
// Which engine is set, and nothing else about it: never the key, never the passphrase, not even
// whether one is stored - an AI failure is engine-shaped, and that is the whole of what helps.
async function aiEngineWord() {
  try {
    const r = await chrome.storage.local.get('aicfg');
    const c = (r && r.aicfg) || {};
    return c.active === 'anthropic' || c.active === 'openai' ? c.active : 'not configured';
  } catch (_) { return 'unknown'; }
}
// The report is handed to the page through the DOM, never through the address. It used to travel in
// the URL fragment, on the reasoning that a fragment is never transmitted to a server - true, and
// not the whole question: the navigation itself is written to Chrome's history and syncs with it, so
// the report would have left the machine with no click at all. Found by an audit of this feature.
//
// One click, one place to read it. The panel used to show the text in a dialog and call its button
// «Send…», which sent nothing: the reader read the same text twice and only the second copy had the
// button that mattered. What that step was defending - «read it before it leaves the machine» - is
// not what it did, because nothing leaves when the page opens: the text is written into a page in
// front of the reader and stays there until they press Send. So the reading happens once, where the
// sending is. The one thing it did cost is now stated on the site: opening the page is an ordinary
// visit to zoost.it, which a reader who changes their mind on the panel side never made.
$('repdismiss').onclick = () => showEmergency(false);
async function onRepopen() {
  reportText = buildReport(reportFacts(lastThrown, await aiEngineWord()));
  const text = reportText;
  try {
    // A **window**, not a tab. The side panel belongs to the window it is open in, so a new tab
    // opens with this panel still down the side of it - the reader is asked to read a report with
    // the thing that produced it sitting next to the text. A fresh window has no panel in it.
    // `chrome.windows` needs no permission of its own; the writing still does, and that is the
    // `zoost.it` host already declared.
    const win = await chrome.windows.create({ url: 'https://zoost.it/report', focused: true });
    const tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
    if (!tabId) { setReportFallback(); return; }
    const put = (t) => {
      const b = document.getElementById('body');
      if (b) { b.value = t; b.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    // Once, when that tab has finished loading - and only that tab.
    const onDone = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onDone);
      chrome.scripting.executeScript({ target: { tabId }, func: put, args: [text] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onDone);
  } catch (_) {
    setReportFallback();
  }
}
$('repopen').onclick = onRepopen;
// If the tab cannot be opened or written to, say so and leave the reader somewhere to go - a silent
// bail here is a button that looks like it worked.
function setReportFallback() {
  // The sentence below is a claim about the clipboard, so it waits to find out whether it is
  // true. It used to be printed unconditionally beside a `try` that could not catch the
  // write's rejection - so a refused clipboard was announced as a successful one, on the one
  // path whose whole purpose is to leave the reader somewhere to go.
  void sayWhereTheReportWent();
}
// Awaited rather than chained: a `.then(ok, no)` is two scopes nothing can read, and both of them
// write the line the reader acts on.
async function sayWhereTheReportWent() {
  try {
    await navigator.clipboard.writeText(reportText);
  } catch (_) {
    status('Could not open the report page, and the clipboard was refused too. The report is in the panel above - select it and copy it by hand.', 'bad');
    return;
  }
  status('Could not open the report page - the report is on your clipboard. Paste it at zoost.it/report.', 'warn');
}
