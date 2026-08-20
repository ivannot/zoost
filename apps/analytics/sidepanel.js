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
const HOST_RE = new RegExp('^(' + (chrome.runtime.getManifest().host_permissions || [])
  .filter((h) => h.startsWith('https://analytics.'))
  .map((h) => h.replace(/\/\*$/, '').replace(/\./g, '\\.')).join('|') + ')\\/');

const PULL_TITLE = 'Pull all - views, structure, relations, SQL and lineage';
const APP_DIR = 'analytics';                  // this app's subfolder inside the working folder
const APP_DIRS = ['crm', 'analytics'];        // known product folders - not "foreign" content
const CFG = '.zoost.json';
// The pull's own commit marker: `writing` from the first byte of a full pull to its last, `complete`
// after. A mirror mid-write is five files from two moments; the loader refuses it rather than
// presenting it as one. Partial writers (a single re-read, a retry) do not touch it - they replace
// one file, which is atomic enough on its own.
const PULL_STATE = '.pull-state.json';
// The data centre to fall back on when the panel knows neither a workspace nor a tab. A
// display-only copy of a setting: read into a URL, never written from here.
let zohoDc = 'zoho.com';
const PULL_SV = 1;                            // pull schema version; bump when new fields are captured

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
      if (t) { chrome.windows.update(t.windowId, { focused: true }); chrome.tabs.update(t.id, { active: true }); return; }
      chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 });
    });
  } catch (_) {
    try { chrome.windows.create({ url, type: 'popup', width: 1100, height: 880 }); } catch (__) {}
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
const ORPHANS = '__orphans__';
let typeFilter = null, sortKey = 'name', sortDir = 1, selectedId = null, detailTab = 'cols';
let detailLoad = 0;
const detailCurrent = (mine, op) => mine === detailLoad && op.current();

// ---------- status ----------
function status(text, kind) { $('statustext').textContent = text; $('status').className = kind || ''; showEmergency(false); }

// The pointer to zoost.it/emergency: a link that lives in the markup and is only ever shown or
// hidden. Nothing here is ever built from what Zoho answered, which is what keeps the status line
// safe to print a platform error into - it stays textContent, and the link stays static.
//
// Cleared by every status write and set again by the one failure path that should carry it, so it
// cannot linger over a later success. One place to clear, one place to set.
function showEmergency(on) { const a = $('emerg'); if (a) a.classList.toggle('on', !!on); }

// ---------- filesystem ----------
async function ensurePerm(h) { const o = { mode: 'readwrite' }; if ((await h.queryPermission(o)) === 'granted') return true; return (await h.requestPermission(o)) === 'granted'; }
const hasPerm = async (h) => (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
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
  const through = async (fn) => { guard(); const v = await fn(); guard(); return v; };
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
const writeJson = (rel, o, op) => (op ? op.write(rel, JSON.stringify(o, null, 2)) : writeFile(rel, JSON.stringify(o, null, 2)));
// Merge rather than replace. `.zoost.json` holds more than the binding - the workspace's own name
// lives there too - and a whole-object write from any one writer silently drops what the others put
// in it. The CRM learnt this twice; this side inherits the lesson rather than the bug.
// The op reaches here because `.zoost.json` is the file that says which workspace this folder
// mirrors. Optional, so the render paths that mean the folder on screen are unchanged.
const patchCfg = async (o, op) => writeJson(CFG, Object.assign({}, await readJson(CFG, {}, op), o), op);
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
    root = h; rootGranted = true; await window.idbHandle.set('rootDir', h);
    await refreshWorkspaces();
    status(`Working folder: ${h.name}`, 'ok');
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
    status(`Access granted to ${root.name}.`, 'ok');
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
  $('find').value = '';
  if ($('healthview').classList.contains('show')) renderHealth();
  if ($('aiview').classList.contains('show')) aiContextLabel();
}

// Which workspace the panel should reopen on, remembered in IndexedDB. Two selections overlapping -
// a slow one, then a fast one - resolved in the order the browser finished them, so the panel showed
// the second and reopened on the first. The write is queued and the queued work asks whether it is
// still the current selection: what is persisted is what is on screen, not what finished last.
let _activeWsWrites = Promise.resolve();
function rememberActive(key, id, gen) {
  _activeWsWrites = _activeWsWrites.then(() => (gen === wsGen ? window.idbHandle.set(key, id) : undefined));
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
  bound = { workspace: w.id, name: w.cfg.name || '', origin: w.cfg.origin || '', label: w.cfg.label || '', sample: !!w.cfg.sample };
  const op = beginWorkspaceOp();
  await rememberActive('activeWsAnalytics', w.id, gen);
  if (!op.current()) return;   // a second selection overtook this one while IndexedDB was writing
  // Not on a re-selection of the workspace already open - regranting a folder must not throw
  // away a conversation about the workspace you are still in.
  if (!sameWs) {
    const n = dropWorkspaceState();
    if (n) status(`Workspace changed - the assistant's ${n}-message conversation was cleared: it was about the other workspace.`, 'warn');
  }
  if (!(await loadFromDisk(op))) return;
  if (!sameWs) resetView();   // after the load: Health is rendered from what is now in memory
  if (!op.current()) return;
  await refreshContext();
}

async function addWorkspace() {
  if (workspaceChangeRefuse()) return;
  if (!root) return status('Pick a working folder first.', 'warn');
  if (!ctx || !ctx.workspace) return status('Open a Zoho Analytics workspace in the active tab first.', 'warn');
  setBusy(true, 'Creating the workspace folder…');
  try {
    const info = await toBridge({ cmd: 'workspaceInfo' });
    const base = await appRoot(true);
    if (!base) throw new Error(`could not create the ${APP_DIR}/ folder`);
    const folder = stemOf(info.name || 'workspace', info.workspace);
    const h = await base.getDirectoryHandle(folder, { create: true });
    dir = h; forgetDirs();
    await patchCfg({ workspace: info.workspace, name: info.name, origin: info.origin, sv: PULL_SV, lastPull: null });
    setBusy(false, `Workspace «${info.name || info.workspace}» created. Press Pull all.`);
    $('status').className = 'ok';
    await refreshWorkspaces();
  } catch (e) {
    setBusy(false, 'Could not create the workspace: ' + (e.message || e));
    $('status').className = 'bad';
  }
}

// Deleting the local mirror only. The confirmation says so explicitly, because "Remove workspace"
// next to a tool that talks to Zoho is exactly the phrase someone reads as "delete it in Zoho".
async function delWorkspace() {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value);
  if (!w || !root) return;
  if (!confirm(`Delete the folder «${w.folder}» and everything in it?\n\nThis removes the local mirror only - nothing in Zoho Analytics is touched. You can pull it again at any time.`)) return;
  try {
    if (!(await ensurePerm(root))) return;
    const base = await appRoot(false);
    if (!base) { status('Could not open the workspace folder.', 'warn'); return; }
    await base.removeEntry(w.folder, { recursive: true });   // delete inside analytics/, never at the root
    await window.idbHandle.set('activeWsAnalytics', null);
    dir = null; bound = null; forgetDirs();
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null;
    $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; navClear();
    status(`Removed ${w.folder}.`, 'ok');
    await refreshWorkspaces();
    render();
  } catch (e) { status('Remove failed: ' + (e.message || e), 'warn'); }
}

// ---------- tab / bridge ----------
async function analyticsTabId() {
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  return a && HOST_RE.test(a.url || '') ? a.id : null;
}
async function ensureBridge(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { cmd: 'context' }); return true; }
  catch {
    // The one recovery the "never click-and-hope" rule allows: re-inject a script we own, once.
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content-bridge.js'] }); await sleep(60); return true; }
    catch { return false; }
  }
}
async function toBridge(msg) {
  // The last line, below every disabled control and every guard above it. The panel speaks to the
  // tab that is open, so a command that is not the context probe must not travel while that tab is a
  // different workspace from the one this panel is bound to - whatever removed the `disabled`, and
  // whoever called the function directly. `context` is how the mismatch is detected in the first
  // place, so it is the one thing that always goes; and a panel with nothing bound yet is creating
  // its first workspace, which is not a mismatch.
  if (msg && msg.cmd !== 'context' && bound && !guardOk()) throw new Error(MSG.mismatchRefused);
  const id = await analyticsTabId();
  if (id == null) throw new Error('The active tab is not Zoho Analytics.');
  await ensureBridge(id);
  // The identity travels with the command and is checked *in the page that will run it* - see the
  // note in the CRM twin. Everything above is a check against a memory of which workspace the tab
  // was showing, with three awaits between reading it and arriving.
  const expected = (msg && msg.cmd !== 'context' && bound)
    ? { workspace: bound.workspace, origin: bound.origin } : null;
  const r = await chrome.tabs.sendMessage(id, expected ? { ...msg, __zoostExpected: expected } : msg);
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
  try {
    const r = await chrome.tabs.sendMessage(id, { cmd: 'context' });
    if (!current()) return;
    ctx = r && r.ok ? r : null;
  } catch (_) { if (!current()) return; ctx = null; }

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
      : `The tab is workspace ${ctx.workspace}; this folder mirrors \u00ab${bound.name || bound.workspace}\u00bb (${bound.workspace}). Pulling is off until they match; what is already mirrored stays readable.`;
    // Two ways out, as the CRM offers: take the tab to the bound workspace, or move this panel to
    // the workspace the tab is already in - switching to it if it exists locally, creating it if not.
    // The first is meaningless for a sample: there is no Zoho Analytics workspace to switch to.
    $('mmgo').style.display = sampleMm ? 'none' : '';
    $('mmgo').textContent = `Switch tab \u2192 \u00ab${bound.name || bound.workspace}\u00bb \u2197`;
    $('mmgo').onclick = () => switchTab();
    const match = (wsList || []).find((w) => w.id === String(ctx.workspace) && w.id !== bound.workspace);
    const sw = $('mmsw'); sw.className = 'znav'; sw.style.display = sampleMm ? 'none' : '';
    if (match) { sw.textContent = `Switch workspace \u2192 \u00ab${match.name || match.folder}\u00bb`; sw.onclick = () => { $('ws').value = match.id; selectWorkspace(match); }; }
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
async function switchTab() {
  if (sampleRefuse()) return;
  const id = await analyticsTabId();
  const url = workspaceUrl();
  if (id) await chrome.tabs.update(id, { url, active: true }); else await chrome.tabs.create({ url, active: true });
}
async function openZohoHome() {
  if (sampleRefuse()) return;
  const [a] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = homeUrl();
  if (a && HOST_RE.test(a.url || '')) await chrome.tabs.update(a.id, { url, active: true });
  else await chrome.tabs.create({ url, active: true });
}

function updateButtons() {
  renderGoDc();                      // the list it offers is the workspaces, so it moves with them
  $('ws').disabled = pullBusy;
  $('wsroot').disabled = pullBusy;
  // Same rule as the CRM panel, and the same reason. Analytics had no such check at all: it left
  // the button offering to "create" a workspace that already existed, and reopened the same folder.
  // Harmless, and still a control saying it will do something it will not.
  const known = (wsList || []).some((w) => ctx && ctx.workspace && String(w.id) === String(ctx.workspace));
  $('wsadd').hidden = known;
  // Absent once one exists, and the overlay's copy says which of the two it will do. Both are
  // decided in one place, because they were decided in two and disagreed.
  updateSampleButtons();
  $('wsadd').disabled = pullBusy || busy || !root || !rootGranted || !ctx || !ctx.workspace;
  $('wsdel').disabled = pullBusy || busy || !dir || !wsList.length;
  $('wsrename').disabled = pullBusy || busy || !dir || !wsList.length;   // temporarily unavailable: pick a workspace and it works
  $('pull').disabled = busy || !dir || !guardOk();
  // Absent, not disabled, when there is nothing to retry - the CRM's equivalent does the same.
  // A greyed button still says "there is something here you cannot have", which is misleading
  // when there is no something. The label carries the count, so the button is self-explaining.
  const rb = $('retry');
  rb.style.display = pullFailed.length ? '' : 'none';
  rb.textContent = `Retry ${pullFailed.length} failed`;
  rb.disabled = busy || !dir || !guardOk();
  $('refresh').disabled = busy || (!dir && !(root && !rootGranted));
  const loaded = views.length > 0;
  $('export').disabled = busy || !loaded;
  $('exportmd').disabled = busy || !loaded;
  $('graph').disabled = busy || !Object.keys(schema).length;
  $('health').disabled = busy || !loaded;
  $('askai').disabled = busy || !loaded;
  // Back to the button's own title, never to nothing. This wrote '' on every state refresh, which
  // was survivable while the button said "Pull all" and is not now that it is a mark: the tooltip is
  // where the name lives. A control that loses its name on the first repaint has no name.
  $('pull').title = $('pull').disabled && dir && ctx && ctx.workspace && !guardOk()
    ? 'The active tab is a different workspace from the one selected here.'
    : PULL_TITLE;
}
function setBusy(on, text) { busy = on; status(text || (on ? 'Working…' : 'Ready.'), on ? 'busy' : ''); updateButtons(); }
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
  views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; pullFailed = [];
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
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
      : 'Pull failed: ' + (e.message || e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
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
      : `Could not re-read «${v.name}»: ` + (e.message || e));
    $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
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
      : 'Retry failed: ' + (e.message || e)); $('status').className = 'bad';
    showEmergency(!(e && e.forbidden));
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
async function pruneSql(index, op) {
  const keep = new Set(Object.values(index).map((e) => `sql/${e.stem}.sql`));
  let failed = 0;
  for await (const p of walk(op.root)) {
    if (!/^sql\/[^/]+\.sql$/.test(p) || keep.has(p)) continue;
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
  await op.write(PULL_STATE, JSON.stringify({ state: 'writing', startedAt: new Date().toISOString() }));
  try {
    await writeJson('views.json', { workspace: info.workspace, pulledAt: new Date().toISOString(), folders, views }, op);
    await writeJson('schema.json', { workspace: info.workspace, tables: schema, relations }, op);
    await writeJson('lineage.json', { workspace: info.workspace, deps, failed: pullFailed }, op);
    // One .sql per query table, so the workspace is diffable in git - that is the whole point of the
    // mirror. The index keeps the id-to-file mapping and the column-level lineage beside it.
    const index = {};
    for (const [id, q] of Object.entries(sqls)) {
      const v = views.find((x) => x.id === id);
      const stem = stemOf(v ? v.name : id, id);
      await op.write(`sql/${stem}.sql`, typeof q.sql === 'string' ? q.sql : '');
      index[id] = { stem, name: v ? v.name : '', parents: q.parents, sources: q.sources };
    }
    await writeJson('sql/index.json', index, op);
    next.cleanupFailed = await pruneSql(index, op);
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
            label: cfg.label || '', sample: !!cfg.sample };
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
    views = []; folders = []; schema = {}; relations = []; sqls = {}; deps = null; pullFailed = [];
    render();
    status('The last pull was interrupted mid-write, so the files on disk describe two different moments - run Pull all to repair the mirror.', 'warn');
    return false;
  }
  let failed = null;
  const noteFailure = (f) => { failed = failed || f; };
  const readOne = (rel) => readJson(rel, null, op, noteFailure);
  const v = await readOne('views.json');
  const s = await readOne('schema.json');
  const l = await readOne('lineage.json');
  const index = await readOne('sql/index.json');
  if (!op.current()) return false;
  views = (v && v.views) || []; folders = (v && v.folders) || [];
  schema = (s && s.tables) || {}; relations = (s && s.relations) || [];
  deps = l && l.deps ? l.deps : null; pullFailed = (l && l.failed) || [];
  sqls = {};
  sqlCache = null; sqlUnread = 0; sqlDiskUnread.clear();
  if (searchMode === 'sql') {
    searchMode = 'name';
    $('smode').textContent = 'in: names';
    $('smode').classList.remove('on');
    $('find').placeholder = 'Find\u2026';
    $('rxmode').style.display = $('rxpick').style.display = 'none';
    $('rxmenu').classList.remove('show');
  }
  if (regexMode) { regexMode = false; $('rxmode').classList.remove('on'); }
  if (index) for (const [id, e] of Object.entries(index)) sqls[id] = { id, sql: null, stem: e.stem, parents: e.parents || [], sources: e.sources || {} };
  mergeSchemaIntoViews();
  diskUnreadable = views.length ? null : failed;
  // Another workspace on disk: the chain is dropped, because every step in it is a view id that
  // belongs to the one being left. This and the removal below are the only places that forget.
  selectedId = null; navClear(); $('detail').classList.remove('show'); $('resizer').classList.remove('show');
  render();
  if (views.length) status(`${views.length} views loaded from disk${v && v.pulledAt ? ' · pulled ' + v.pulledAt.slice(0, 10) : ''}.`, '');
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
  sel.value = typeFilter || '';
}

// ---- searching inside the SQL ------------------------------------------------------------------
// `in: names` looks at what the list already shows - name, folder, column names. `in: SQL` looks
// inside the queries themselves, which is what «search across every query at once» has always meant
// to a reader and what this panel could not do: the text is not in memory, it is read per view when
// you open one. So the first search of a session reads every .sql file once and keeps it.
let searchMode = 'name';        // 'name' | 'sql'
let regexMode = false;          // the .* toggle: the search text read as a pattern, full-text mode only
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
  if (searchMode !== 'sql') return null;
  const q = $('find').value.trim();
  if (!q) return null;
  if (!regexMode) return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim');
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
  const entries = Object.entries(sqls).filter(([, q]) => q && q.stem);
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
  const q = $('find').value.trim().toLowerCase();
  let out = views;
  if (typeFilter === ORPHANS) out = out.filter(isOrphanCandidate);
  else if (typeFilter) out = out.filter((v) => v.type === typeFilter);
  if (q && searchMode === 'sql') {
    // Only what has SQL can match, and only what has been read: a query whose file would not open is
    // counted by ensureSqlCache() and reported, not quietly turned into «no match».
    const rx = regexMode ? rxCompile($('find').value.trim()) : null;
    // A broken pattern searched nothing, so it matches nothing: render() names the error, and this
    // empties the list so the keyboard cannot step onto rows the reader was just told do not exist.
    out = rx && rx.error ? [] : out.filter((v) => sqlCache && sqlHit(sqlCache.get(v.id), q, rx && rx.re));
  } else if (q) {
    out = out.filter((v) => {
      if ((v.name || '').toLowerCase().includes(q) || (v.folderName || '').toLowerCase().includes(q)) return true;
      const t = schema[v.id];                  // searching a column name finds the tables that have it
      return !!(t && t.columns.some((c) => c.name.toLowerCase().includes(q)));
    });
  }
  return out.slice().sort((a, b) => {
    if (sortKey === 'readBy') {
      // Absent lineage sorts last in both directions, like an absent timestamp: "not pulled" is not
      // the same as "nothing reads it", and putting them at zero would say it was.
      const cnt = (v) => { const d = deps && deps[v.id]; return d ? d.children.length + d.dashboards.length : null; };
      const x = cnt(a), y = cnt(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sortDir;
    }
    if (sortKey === 'dataModifiedAt' || sortKey === 'designModifiedAt') {
      // Views with no timestamp sort last in both directions - an absent value is not "oldest".
      const x = a[sortKey], y = b[sortKey];
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return (x - y) * sortDir;
    }
    const x = a[sortKey] ?? '', y = b[sortKey] ?? '';
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sortDir;
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
    return '<b>No working folder yet.</b> Press <b>\u{1F4C1} Set working folder\u2026</b> above and pick a '
      + 'dedicated, empty folder. Every workspace lives inside it.';
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
  const rawQ = $('find').value.trim();
  if (searchMode === 'sql' && regexMode && rawQ) {
    const rxErr = rxCompile(rawQ).error;
    if (rxErr) {
      // «No matches» for a pattern that never ran would be the lie this panel exists to refuse.
      list.innerHTML = `<div class="empty"><b>The pattern does not parse.</b> ${esc(rxErr)}. Nothing was searched - fix the pattern or switch .* off.</div>`;
      return;
    }
  }
  const rows = visibleViews();
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><b>No view matches.</b>
      ${typeFilter ? 'The type filter and the' : 'The'} search box are narrowing ${views.length} views down to none.
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
  const hlRe = rawQ && searchMode === 'sql'
    ? (regexMode ? rxCompile(rawQ).re : new RegExp(rawQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gim'))
    : null;
  const sqlLine = (v) => {
    if (searchMode !== 'sql' || !sqlCache || !hlRe) return '';
    const h = sqlHit(sqlCache.get(v.id), rawQ, regexMode ? hlRe : null);
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
      if (searchMode === 'sql' && $('find').value.trim()) detailTab = 'sql';
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
  selectedId = id;
  const v = viewById().get(id);
  if (!v) return;
  // Every way in passes through here - a row click, an arrow key, a foreign key, a lineage entry -
  // so the history is complete without any of them knowing it exists. The kind is carried too, so
  // the chain reads «query table Funnel» rather than a bare name.
  navHere(id, v.name); { const e = navHist[navPos]; if (e) e.kind = v.type; }
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
  $('dzoho').onclick = () => { if (zurl) chrome.tabs.create({ url: zurl }); };
  $('dtitle').title = `${v.type} · ${v.folderName || 'no folder'} · id ${v.id}`;
  // A tab that cannot say anything about this view is disabled, not shown and silently empty.
  $('tab_sql').disabled = !sqls[id];
  $('tab_rel').disabled = !relationsOf(id).length;
  $('tab_lin').disabled = !deps;
  if (detailTab === 'sql' && !sqls[id]) detailTab = 'cols';
  if (detailTab === 'rel' && !relationsOf(id).length) detailTab = 'cols';
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
    const sql = await sqlBodyOf(v.id, op);
    if (!detailCurrent(mine, op)) return false;
    // Only where there is code to take: this is the one tab of the four that shows any.
    $('codecopy').style.display = (sql && sql.trim()) ? '' : 'none';
    body.innerHTML = '<div class="dpad">' + (sql && sql.trim()
      // Highlighted, and still escaped: `highlightSql` tokenises the raw text and escapes every
      // piece itself, which is the only reason it may be handed to innerHTML at all.
      ? `<pre class="sql">${window.highlightSql ? window.highlightSql(sql) : esc(sql)}</pre>`
      : `<div class="empty" style="padding:0"><b>${sql == null ? 'The SQL file could not be read.' : 'No SQL text.'}</b> ${esc(sqlText(sql))}</div>`) + '</div>';
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
  await loadFromDisk();
  setBusy(false);
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
    workspace: { instance: bound ? (bound.name || bound.workspace) : null, org: bound ? bound.workspace : null,
                 label: (bound && bound.label) || null },
  };
}

// What the diagram window is given, which is less than what the panel holds. `source_code` is put
// back onto the graph nodes by loadGraph() for the assistant and the Markdown export - both of which
// read it from memory - and the window has never touched it: it draws names, kinds and arrows. So it
// is stripped here rather than shipped and forgotten, because the payload crosses into storage and
// what crosses a boundary is what has to be justified.
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
    if (on) { $('ailockpass').value = ''; aiLockMsg(''); $('ailockpass').focus(); }
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
    status('Wrong passphrase.', 'warn');
    $('ailockpass').select(); return;
  }
  await window.ZOOST_KEYVAULT.remember(prov, key);
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
  if (!chain) return `${v.name} (${v.type}) has no columns and no reachable source.`;
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
let aiSeedSize = 0;                     // what the last index actually came to, shown in the chat

async function aiBuildSeed(cap, op = beginWorkspaceOp()) {
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
  let out = header + tables;
  if (out.length + reports.length <= cap) out += reports;
  else if (reports) omitted.push(`the ${pres.length} reports and pivots`);
  if (out.length + dashboards.length <= cap) out += dashboards;
  else if (dashboards) omitted.push(`the ${dashList.length} dashboards`);

  if (!op.current()) throw new Error(WS_MOVED);
  aiSeedOmitted = omitted;
  if (out.length > cap) {          // even the tables alone overflow: an enormous workspace
    aiSeedOmitted = [`part of the table list - this workspace is larger than the index can hold`];
    out = aiTrunc(out, cap);
  }
  aiSeedTruncated = omitted.length > 0 || out.length >= cap;
  if (omitted.length) {
    out += `\nNOT LISTED ABOVE: ${omitted.join(' and ')}. They exist and you can find them by name`
      + ` with list_views (it takes a name substring and a type) - do not assume a view is absent`
      + ` because it is not in this index.\n`;
  }
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
    ? 'You have READ-ONLY tools over the local mirror: list_views, get_view, get_structure, get_sql, search_sql, search_columns, get_relations, who_uses, orphans. Use them to fetch exact structure and SQL instead of guessing. get_view returns the whole dossier for one view - structure, foreign keys, SQL and lineage - so prefer it over three narrower calls, and prefer search_columns or search_sql over opening views one at a time.'
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

async function aiExecTool(name, input, op = beginWorkspaceOp()) {
  input = input || {};
  const m = viewById();
  if (name === 'list_views') {
    const f = (input.filter || '').toLowerCase(), ty = (input.type || '').toLowerCase(), minc = Number(input.min_columns) || 0;
    const rows = views.filter((v) => (!f || (v.name || '').toLowerCase().includes(f)) && (!ty || (v.type || '').toLowerCase() === ty)
      && (!minc || (schema[v.id] ? schema[v.id].columns.length : 0) >= minc));
    if (!rows.length) return `0 views match. ${views.length} in the workspace.`;
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
    return hits.length ? `${hits.length} table(s) have a matching column:\n` + aiCap(hits, hits.length, MSG.narrow) : '(no matches)';
  }
  if (name === 'get_relations') {
    const list = v ? relationsOf(v.id) : relations;
    if (!list.length) return v ? `${v.name} takes part in no relation.` : 'No relations in this workspace.';
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
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const post = async (limitField) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
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
    if (withTools) await aiRunAnthropicAgent(cfg.anthropic, apiMessages, system, AI_TOOLS, cfg.maxIter || 20, current, op);
    else { const reply = await aiCall(cfg, apiMessages, system); if (!current()) return; aiMessages.push({ role: 'assistant', content: reply || '(empty response)' }); }
    if (!current()) return;
    status('', '');
  } catch (e) { if (!current()) return; aiMessages.push({ role: 'assistant', content: friendlyError(e) }); status('AI error', 'warn'); }
  if (!current()) return;
  aiBusy = false; $('aisend').disabled = false;
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
  closeHealth();   // one panel at a time
  $('aiview').classList.add('show'); $('askai').classList.add('on'); document.body.classList.add('ai-open');
  aiEngineChrome(); aiRenderMessages();
  aiEnsureFiles().then(() => aiContextLabel());   // the label reads the mirror too, and fills in when its measurement lands
}
function closeAI() { $('aiview').classList.remove('show'); $('askai').classList.remove('on'); document.body.classList.remove('ai-open'); }
function aiClear() { if (!aiMessages.length) return; if (!window.confirm('Clear this conversation? Only you can clear it - switching workspace does it too, because the old thread was about another workspace.')) return; dropWorkspaceState(); }

// ---------- export ----------
// Coarse scope on purpose: sections, never single views. Kept in IndexedDB beside the folder handle
// rather than chrome.storage, so this build still needs no `storage` permission - the same choice,
// one fewer thing to justify.
const SCOPE_KEYS = ['views', 'structure', 'relations', 'sql', 'lineage', 'health'];
const SCOPE_FULL = { views: true, structure: true, relations: true, sql: true, lineage: true, health: true };
const SCOPE_SAFE = { views: true, structure: true, relations: true, sql: false, lineage: true, health: true };
// The same promise as the CRM's, kept the same way: §4.3 of the privacy policy names «the SQL of your
// query tables» as the sensitive half of an Analytics export, so it starts unticked. Everything else
// stays on.
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { sql: false });
const SCOPE_SV = 2;
let expScope = Object.assign({}, SCOPE_DEFAULT);
async function loadScope() {
  // The twin of the CRM's, for the same reason and with the same one-shot stamp: a scope saved while
  // the dialog opened with the SQL ticked is not evidence that anybody chose it.
  try {
    const v = await window.idbHandle.get('exportScopeAnalytics');
    if (v) {
      if (v.sv !== SCOPE_SV) { v.sql = false; v.sv = SCOPE_SV; await window.idbHandle.set('exportScopeAnalytics', v); }
      expScope = Object.assign({}, SCOPE_DEFAULT, v);
    }
  } catch (_) {}
}
function scopeToUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!expScope[k]; });
  const q = $('sc_sql'); if (q) q.disabled = !expScope.structure;
  $('scwarn').textContent = expScope.sql ? '\u26a0 includes the full SQL of every query table' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) expScope[k] = !!e.checked; });
  if (!expScope.structure) expScope.sql = false;
  scopeToUI();
}
let _scopeResolve = null;
function askScope() {
  return new Promise((resolve) => {
    _scopeResolve = resolve; scopeToUI();
    $('scrim').classList.add('on'); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  if (r) r(ok ? Object.assign({}, expScope) : null);
}

// Both reports carry exactly what the panel shows, and nothing invented here: a figure that lives
// only on screen would make the report a quietly lesser copy, and the reader could not know it.
// Same facts as the panel's References column, as text. A report that omitted them would be a
// quietly lesser copy of what the reader saw on screen, and they could not know it.
function fkText(viewId, colName) {
  const { out, inc } = foreignKeys(viewId);
  return [].concat(
    (out.get(colName) || []).map((f) => `→ ${f.name}.${f.column}`),
    (inc.get(colName) || []).map((f) => `← ${f.name}.${f.column}`),
  ).join(', ');
}

function exportSections(sc) {
  const m = viewById();
  const h = healthFindings();
  const out = [];
  if (sc.views) out.push({ id: 'views', title: 'Views', rows: views.map((v) => [v.name, v.type, v.folderName || '—', v.owner || '—', v.designModifiedAt ? shortDate(v.designModifiedAt) : (v.designModifiedText || '—'), shortDate(v.dataModifiedAt), v.system ? 'system' : '']),
    head: ['View', 'Type', 'Folder', 'Owner', 'Design', 'Data', ''] });
  if (sc.structure) out.push({ id: 'structure', title: 'Structure', tables: Object.entries(schema).map(([id, t]) => ({ id, ...t })) });
  if (sc.relations) out.push({ id: 'relations', title: 'Relations', rows: relations.map((r) => [r.sourceName, r.targetName, r.relation]), head: ['From', 'To', 'Join'] });
  if (sc.sql) out.push({ id: 'sql', title: 'Query table SQL' });
  if (sc.lineage && deps) out.push({ id: 'lineage', title: 'Lineage', rows: views.filter((v) => deps[v.id]).map((v) => [v.name, String(deps[v.id].parents.length), String(deps[v.id].children.length), String(deps[v.id].dashboards.length)]), head: ['View', 'Reads from', 'Read by', 'On dashboards'] });
  if (sc.health) out.push({ id: 'health', title: 'Health', h });
  return out;
}

async function buildExportHtml(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const esc2 = esc;
  const toc = secs.map((x) => `<li><a href="#${x.id}">${esc2(x.title)}</a></li>`).join('');
  const tbl = (head, rows) => `<table><thead><tr>${head.map((h2) => `<th>${esc2(h2)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let body = '';
  for (const x of secs) {
    body += `<h2 id="${escA(x.id)}">${esc2(x.title)}</h2>`;
    if (x.rows) body += tbl(x.head, x.rows);
    else if (x.tables) body += x.tables.map((t) => `<h3>${esc2(t.name)} <small>${esc2(t.kind)}${t.system ? ' · system' : ''}</small></h3>` + tbl(['Column', 'Type', 'References'], t.columns.map((c) => [c.name, c.type, fkText(t.id, c.name)]))).join('');
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        // Skipping an unread query made the export silently smaller than the workspace: a reader
        // cannot tell a query that was dropped from one that never existed. The heading is always
        // there; what varies is whether the source or the reason sits under it.
        const st = await sqlReadState(v.id, op);
        if (st.kind === 'unread') { body += `<h3>${esc2(v.name)}</h3><p class="note">Its SQL could not be read (${esc2(st.error)}) - Retry failed / Pull all fetches it.</p>`; continue; }
        body += `<h3>${esc2(v.name)}</h3><pre>${esc2(sqlText(st.body))}</pre>`;
      }
    } else if (x.h) {
      const H = x.h;
      body += `<p><b>${H.counts.views}</b> views · <b>${H.counts.tables}</b> tables · <b>${H.counts.columns}</b> columns · <b>${H.counts.relations}</b> relations · <b>${H.counts.sql}</b> SQL</p>`
        + `<p class="gap">Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.</p>`
        + `<h3>Nothing depends on them (${H.orphans ? H.orphans.length : '—'})</h3><p class="gap">Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.</p>`
        + (H.orphans ? `<ul>${H.orphans.map((v) => `<li>${esc2(v.name)} <i>${esc2(v.type)}</i></li>`).join('')}</ul>` : '')
        + `<h3>Tables in no relation (${H.islands.length})</h3><ul>${H.islands.map((t) => `<li>${esc2(t.name)} <i>${esc2(t.kind)}</i></li>`).join('')}</ul>`
        + `<h3>Put there by Zoho, not by you (${H.system.length})</h3><ul>${H.system.map((v) => `<li>${esc2(v.name)}</li>`).join('')}</ul>`
        + (H.unread.length ? `<h3>Could not be read (${H.unread.length})</h3><ul>${H.unread.map((f) => `<li>${esc2((viewById().get(f.id) || {}).name || f.id)} - ${esc2(f.error)}</li>`).join('')}</ul>` : '');
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zoost - ${esc2(bound.label || bound.name || bound.workspace)}</title><style>
body{font:14px/1.6 system-ui,sans-serif;color:#1b2431;background:#fff;margin:0;padding:28px;max-width:1100px}
h1{margin:0 0 4px} h2{margin:30px 0 8px;padding-top:8px;border-top:2px solid #e6ebf2} h3{margin:18px 0 6px;font-size:15px}
small,i{color:#6b7a90;font-weight:400;font-style:normal}
table{border-collapse:collapse;width:100%;margin:6px 0;font-size:12.5px;display:block;overflow-x:auto}
th{background:#f3f6fa;text-align:left;padding:5px 8px;border-bottom:2px solid #dde4ee;white-space:nowrap}
td{padding:4px 8px;border-bottom:1px solid #eef2f7;vertical-align:top}
pre{background:#f7f9fc;border:1px solid #e3e9f2;border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}
.meta{color:#6b7a90;font-size:12.5px} .gap{color:#6b7a90;font-size:12.5px;border-left:3px solid #e6ebf2;padding-left:10px}
nav ul{columns:2;list-style:none;padding:0} nav a{color:#0e9488;text-decoration:none}
footer{margin-top:36px;padding-top:12px;border-top:1px solid #e6ebf2;color:#6b7a90;font-size:12px}
</style></head><body>
<h1>${esc2(bound.label || bound.name || bound.workspace)}</h1>
<div class="meta">${bound.label ? `Zoho Analytics workspace ${esc2(bound.name || '')} \u00b7 ` : 'Zoho Analytics workspace '}${esc2(bound.workspace)} · ${esc2(bound.origin || '')} · exported ${new Date().toISOString().slice(0, 10)} by ${esc2(PRODUCT_NAME)} v${esc2(chrome.runtime.getManifest().version)}</div>
<nav><ul>${toc}</ul></nav>
${body}
<footer>Read-only mirror. Zoost never creates, edits or deletes anything in Zoho Analytics, and never reads record data.<br>${esc2(LEGAL_DISCLAIMER)}</footer>
</body></html>`;
}

async function buildExportMarkdown(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const row = (r) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  let out = `# ${bound.label || bound.name || bound.workspace}\n\nZoho Analytics workspace ${bound.label && bound.name ? `${bound.name} ` : ''}\`${bound.workspace}\` · exported ${new Date().toISOString().slice(0, 10)} by ${PRODUCT_NAME} v${chrome.runtime.getManifest().version}\n\n`;
  out += '> Read-only mirror. Zoost never writes to Zoho Analytics and never reads record data.\n\n';
  out += '## Contents\n\n' + secs.map((x) => `- ${x.title}`).join('\n') + '\n- Zoho Analytics SQL - what query tables allow\n\n';
  // The dialect reference travels with the export on purpose: this file exists to be handed to an
  // agent that has never seen Analytics, and a workspace description without the tool's constraints
  // would get it writing SQL that cannot run.
  out += window.ZOHO_ANALYTICS_SQL.markdown() + '\n';
  for (const x of secs) {
    out += `## ${x.title}\n\n`;
    if (x.rows) out += row(x.head) + '\n' + row(x.head.map(() => '---')) + '\n' + x.rows.map(row).join('\n') + '\n\n';
    else if (x.tables) for (const t of x.tables) out += `### ${t.name} (${t.kind}${t.system ? ', system' : ''})\n\n| Column | Type | References |\n| --- | --- | --- |\n` + t.columns.map((c) => row([c.name, c.type, fkText(t.id, c.name)])).join('\n') + '\n\n';
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        const st = await sqlReadState(v.id, op);
        if (st.kind === 'unread') { out += `### ${v.name}\n\n> Its SQL could not be read (${st.error}) - Retry failed / Pull all fetches it.\n\n`; continue; }
        const src = st.body;
        out += `### ${v.name}\n\n\u0060\u0060\u0060sql\n${src && src.trim() ? src : '-- ' + sqlText(src)}\n\u0060\u0060\u0060\n\n`;
      }
    } else if (x.h) {
      const H = x.h;
      out += `${H.counts.views} views · ${H.counts.tables} tables · ${H.counts.columns} columns · ${H.counts.relations} relations · ${H.counts.sql} SQL\n\n`;
      out += '> Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.\n\n';
      out += `### Nothing depends on them (${H.orphans ? H.orphans.length : '—'})\n\n> Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.\n\n`;
      if (H.orphans) out += H.orphans.map((v) => `- ${v.name} (${v.type})`).join('\n') + '\n\n';
      out += `### Tables in no relation (${H.islands.length})\n\n` + H.islands.map((t) => `- ${t.name} (${t.kind})`).join('\n') + '\n\n';
      out += `### Put there by Zoho, not by you (${H.system.length})\n\n` + H.system.map((v) => `- ${v.name}`).join('\n') + '\n\n';
      if (H.unread.length) out += `### Could not be read (${H.unread.length})\n\n` + H.unread.map((f) => `- ${(viewById().get(f.id) || {}).name || f.id} - ${f.error}`).join('\n') + '\n\n';
    }
  }
  return out;
}

// Folder, filename shape, timestamp format, permission check and status wording are all the CRM
// panel's, deliberately: an export is the artefact a user collects from both apps, and finding it
// somewhere else in one of them is precisely the discontinuity the two are supposed to avoid.
// There is no "analytics" in the filename because the workspace already sits under analytics/, and
// the CRM does not put "crm" in its own.
async function doExport(kind) {
  const op = beginWorkspaceOp();   // the scope dialog and the build both await; the folder can move
  if (!dir) return;
  const sc = await askScope();
  if (!sc) return;
  await window.idbHandle.set('exportScopeAnalytics', sc);
  setBusy(true, kind === 'md' ? 'Building AI (Markdown) export…' : 'Building HTML export…');
  try {
    await requirePerm(op.root);
    const md = kind === 'md';
    const body = md ? await buildExportMarkdown(sc, op) : await buildExportHtml(sc, op);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `export/zoost-${sanitize((bound && (bound.name || bound.workspace)) || 'workspace')}-${stamp}.${md ? 'md' : 'html'}`;
    await op.write(name, body);
    setBusy(false, `Exported → ${name} (in your workspace folder).`); $('status').className = 'ok';
  } catch (e) {
    if (!op.current()) { endBusyElsewhere(); return; }
    setBusy(false, 'Export error: ' + (e.message || e)); $('status').className = 'bad';
  }
}

// ---------- health ----------
// Counts and lists, never a verdict. No thresholds, no "too old", no score: a query table nobody
// reads may be a scheduled export's source, and a table with no relations may be deliberately
// standalone. Every figure states what it does not cover, right next to itself.
function healthFindings() {
  const m = viewById();
  const tables = Object.entries(schema);
  const related = new Set();
  for (const r of relations) { related.add(r.source); related.add(r.target); }
  const unread = pullFailed.slice();
  for (const id of sqlDiskUnread) {
    if (!unread.some((f) => String(f.id) === String(id) && f.stage === 'sql'))
      unread.push({ id, stage: 'sql', error: 'the .sql file could not be read' });
  }
  return {
    counts: {
      views: views.length, folders: folders.length,
      tables: tables.length, columns: tables.reduce((n, [, t]) => n + t.columns.length, 0),
      relations: relations.length, sql: Object.keys(sqls).length,
    },
    system: views.filter((v) => v.system),
    orphans: deps ? views.filter(isOrphanCandidate) : null,
    islands: tables.filter(([id]) => !related.has(id)).map(([id, t]) => ({ id, name: t.name, kind: t.kind })),
    undescribed: views.filter((v) => !v.description),
    unread,
    noStructure: views.filter((v) => v.type !== 'Dashboard' && !structureChain(v, m)),
  };
}
function renderHealth() {
  const h = healthFindings();
  const list = (arr, f) => arr.length ? `<ul>${arr.slice(0, 40).map(f).join('')}</ul>${arr.length > 40 ? `<div class="gap">…and ${arr.length - 40} more. The full list is in the exports.</div>` : ''}` : '';
  // A finding that names a view opens it. It was plain text in every one of these lists - reported
  // on the CRM panel, where one group of eight was unclickable; here it was all of them, which is
  // the same defect with nothing to compare it against. The id is what the row declares, and one
  // handler below reads it, so a list added tomorrow is clickable by writing `nm` and nothing else.
  const nm = (v) => `<li><a data-open="${escA(String(v.id))}">${esc(v.name)}</a> <span style="color:var(--muted)">${esc(v.type || v.kind || '')}</span></li>`;
  $('healthbody').innerHTML =
    `<h4>What was pulled</h4><div class="hnum">${h.counts.views} views · ${h.counts.folders} folders · ${h.counts.tables} tables · ${h.counts.columns} columns · ${h.counts.relations} relations · ${h.counts.sql} SQL</div>`
    + `<div class="gap">Report definitions - which columns a chart puts on which axis, and how it aggregates them - are <b>not</b> covered. The endpoint that carries them also carries the computed series, which is your data, so Zoost does not call it.</div>`

    + `<h4>Nothing depends on them <span class="hnum">${h.orphans ? h.orphans.length : '—'}</span></h4>`
    + (h.orphans ? list(h.orphans, nm) : '<div class="gap">Lineage was not pulled.</div>')
    + `<div class="gap">Candidates, not a verdict. Zoho Analytics only knows what its own views read from each other; a shared link, a scheduled export, an embedded report or an API consumer is invisible to it.</div>`

    + `<h4>Tables in no relation <span class="hnum">${h.islands.length}</span></h4>`
    + list(h.islands, nm)
    + `<div class="gap">They take part in no join in the ER model. That can be deliberate - a lookup list, a staging table - so this is a list to read, not a problem to fix.</div>`

    + `<h4>Put there by Zoho, not by you <span class="hnum">${h.system.length}</span></h4>`
    + list(h.system, nm)
    + `<div class="gap">Flagged <code>isSystemTable</code> by Zoho Analytics itself - typically synced from a connected source. The view list does not flag any of them, so this comes from the ER model alone.</div>`

    + `<h4>No description <span class="hnum">${h.undescribed.length}</span> of ${h.counts.views}</h4>`
    + `<div class="gap">A count, not a judgement. Plenty of views need no description.</div>`

    + (h.noStructure.length ? `<h4>No structure reachable <span class="hnum">${h.noStructure.length}</span></h4>` + list(h.noStructure, nm)
       + '<div class="gap">Neither their own columns nor a parent chain leading to any. Dashboards are excluded, since having none is correct for them.</div>' : '')

    + (h.unread.length ? `<h4 style="color:var(--warn)">Could not be read <span class="hnum">${h.unread.length}</span></h4>`
       + list(h.unread, (f) => `<li><a data-open="${escA(String(f.id))}">${esc((viewById().get(f.id) || {}).name || f.id)}</a> - <span style="color:var(--muted)">${esc(f.error)}</span></li>`)
       + '<div class="gap">Use <b>Retry failed</b>, or ↻ on a single view. Until then this mirror is short by exactly these.</div>' : '')

    + `<h4>Design and data dates</h4><div class="gap">Design is a real timestamp for tables and query tables, and Zoho\'s own text for everything else - shown exactly as it sends it, in your interface language, never parsed, and sorted last. Data is always a real timestamp.</div>`;
  $('healthbody').querySelectorAll('a[data-open]').forEach((a) => (a.onclick = () => {
    const id = a.dataset.open;
    if (!viewById().get(id)) { status('That view is no longer in this workspace.', 'warn'); return; }
    closeHealth(); openDetail(id);
  }));
}
function openHealth() { renderHealth(); document.body.classList.add('health-open'); $('healthview').classList.add('show'); }
function closeHealth() { document.body.classList.remove('health-open'); $('healthview').classList.remove('show'); }

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
    + `Zoost has no server of its own. <b>The one exception is the AI assistant</b>: when you use it, the parts of the workspace it needs - view and column names, relations, and the SQL of your query tables - are sent directly from your browser to the provider you configured, and to no one else. `
    + `Rows are never sent, because Zoost never reads them. Leave the assistant unconfigured and nothing leaves this machine.</div>`;
  $('scrim').classList.add('on'); $('aboutdlg').classList.add('on');
}
function closeAbout() { $('scrim').classList.remove('on'); $('aboutdlg').classList.remove('on'); }

// ---------- wiring ----------
$('wsroot').onclick = () => ((root && !rootGranted) ? grantRoot() : pickRoot());
/** What the workspace list shows, and what it must never stop showing.
 *
 * The label is a convenience; the identity is the org or workspace id. So the label is displayed and
 * the derived name is kept - in the option's tooltip, always, whether or not a label is set. A list
 * that showed only the user's name for something would be a list you cannot check against the
 * platform.
 */
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
try { chrome.storage.local.get('sampleWs').then((v) => { sampleWsKnown = (v && v.sampleWs) || null; updateSampleButtons(); }); } catch (_) {}
function noteSampleWs(id) {
  sampleWsKnown = id || null;
  try { chrome.storage.local.set({ sampleWs: sampleWsKnown }); } catch (_) {}
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
  const have = knownSample();
  const sb = $('wssample');
  if (sb) sb.hidden = !!have || !root || !rootGranted;
  if (sb) sb.disabled = pullBusy || sampleBusy;
  // The overlay's copy covers the workspace list, so hiding it there would leave a sample on disk
  // unreachable. It changes what it says instead.
  const ob = $('offsample');
  if (ob) {
    ob.disabled = pullBusy || sampleBusy;
    // Three states, because «+» and «Open» are both claims and there is a moment when neither can be
    // made. `+` says «there is none» and `Open` says «there is one»; with the folder unread the
    // honest label asserts nothing and the tooltip says the click will find out. This project does
    // not state what it has not measured, and a button label is a statement like any other.
    ob.textContent = have ? 'Open sample workspace'
      : sampleKnowable() ? '+ Sample workspace' : 'Sample workspace';
    ob.title = have
      ? 'Open the sample workspace already in your working folder - invented data, nothing is fetched'
      : sampleKnowable()
        ? 'Write a workspace of invented data into the working folder and open it - nothing is fetched, and it can be deleted like any other'
        : 'Opens the sample workspace, or writes one if there is none. Clicking asks for access to the working folder first, which is what the panel needs before it can tell.';
  }
}

let sampleBusy = false;
async function addSampleWorkspace() {
  if (workspaceChangeRefuse()) return;
  if (sampleBusy) return;
  if (!root) { await pickRoot(); return; }
  // **Grant first, then decide.** A click is the only context in which the permission can be
  // re-requested, and until it is granted the panel cannot see what is in the folder - so deciding
  // before this line means deciding on a list that is empty for a reason unrelated to the question.
  if (!(await ensurePerm(root))) return;
  if (!rootGranted) { rootGranted = true; await refreshWorkspaces(); }
  const have = (wsList || []).find((w) => w.cfg && w.cfg.sample);
  if (have) { $('ws').value = have.id; $('offoverlay').classList.remove('show'); return selectWorkspace(have); }
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
    status(`Sample workspace written - ${Object.keys(files).length} files in ${gen.folderName()}. Nothing was fetched from Zoho Analytics.`, 'ok');
    await refreshWorkspaces();
  } catch (e) { status('Could not write the sample: ' + e.message, 'bad'); }
}
$('wsdel').onclick = delWorkspace;
$('ws').onchange = async () => {
  if (workspaceChangeRefuse()) return;
  const w = wsList.find((x) => x.id === $('ws').value); if (w) await selectWorkspace(w);
};
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
let navHist = [], navPos = -1, navReplaying = false, navSeq = 0;

function navHere(id, label) {
  if (navReplaying || !id) return;
  const cur = navHist[navPos];
  if (cur && String(cur.id) === String(id)) { if (label) cur.label = label; updateNav(); return; }
  // A new step drops what was ahead - the forward arrow means «where I came back from».
  navHist = navHist.slice(0, navPos + 1);
  navHist.push({ n: ++navSeq, id: String(id), label: label || String(id), kind: '', at: Date.now() });
  if (navHist.length > NAV_MAX) navHist.shift();
  navPos = navHist.length - 1;
  updateNav();
}
function navClear() { navHist = []; navPos = -1; closeNavMenu(); updateNav(); }

/** Go to step `i`. The position moves even when the view has gone - a workspace can be pulled again
 *  with one fewer query in it - and the status line says so, the same as the twin. */
async function navTo(i) {
  if (i < 0 || i >= navHist.length || i === navPos) return;
  const e = navHist[i];
  navPos = i; navShow(false); updateNav();
  navReplaying = true;
  try {
    if (viewById().get(e.id)) await openDetail(e.id);
    else status(MSG.navGone, 'warn');
  } finally { navReplaying = false; }
}

function updateNav() {
  $('dback').classList.toggle('show', navPos > 0);
  $('dfwd').classList.toggle('show', navPos >= 0 && navPos < navHist.length - 1);
  $('navtab').style.display = navHist.length ? '' : 'none';   // nowhere to go, nothing to offer
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
  const here = navHist[navPos];
  navHist = here ? [here] : []; navPos = navHist.length - 1;
  updateNav(); renderNav();
};
$('navx').onclick = () => navShow(false);
$('dback').onclick = () => navTo(navPos - 1);
$('dfwd').onclick = () => navTo(navPos + 1);
$('navtab').onclick = () => toggleNavMenu();
$('codecopy').onclick = () => copyCode((document.querySelector('pre.sql') || {}).textContent || '');
$('navfind').oninput = renderNav;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navOpenNow()) { navShow(false); return; }
  if (!e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navTo(navPos - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navTo(navPos + 1); }
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

$('find').oninput = () => {
  // Debounced in SQL mode only: a user-authored pattern runs over every cached query body, and
  // doing that on each keystroke means doing it on the half-typed patterns too.
  if (searchMode === 'sql') { clearTimeout(_sqlSearchT); _sqlSearchT = setTimeout(render, 220); }
  else render();
};
$('smode').onclick = async () => {
  const op = beginWorkspaceOp();
  searchMode = searchMode === 'name' ? 'sql' : 'name';
  $('smode').textContent = searchMode === 'name' ? 'in: names' : 'in: SQL';
  $('smode').classList.toggle('on', searchMode === 'sql');
  $('rxmode').style.display = $('rxpick').style.display = searchMode === 'sql' ? '' : 'none';
  if (searchMode !== 'sql') $('rxmenu').classList.remove('show');
  $('find').placeholder = searchMode === 'name' ? 'Find\u2026' : 'Find inside the SQL\u2026';
  if (searchMode === 'sql' && !(await ensureSqlCache(op))) return;
  if (!op.current()) return;
  render();
};
$('rxmode').onclick = () => {
  regexMode = !regexMode;
  $('rxmode').classList.toggle('on', regexMode);
  // Switching the toggle off clears the box: a pattern read as a literal is a search for text
  // that does not exist, and the reader would be left staring at «no matches» for \b\d{18}\b.
  // Switching it on keeps what was typed - a literal is often the seed of the pattern.
  if (!regexMode) $('find').value = '';
  render();
};
// The saved patterns, offered where they are used. The background seeds the first two; the list
// itself lives in Settings, where it can be added to, edited and emptied - the menu only reads,
// fresh on every open, so there is nothing here to fall out of date.
async function loadRxShortcuts() {
  try {
    const st = await chrome.storage.local.get('rxShortcuts');
    return Array.isArray(st.rxShortcuts)
      ? st.rxShortcuts.filter((x) => x && typeof x.name === 'string' && typeof x.pattern === 'string' && x.name && x.pattern)
      : [];
  } catch (_) { return null; }   // null, not []: a read that failed is not an empty list
}
$('rxpick').onclick = async (ev) => {
  ev.stopPropagation();
  const menu = $('rxmenu');
  if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
  const list = await loadRxShortcuts();
  // The read yielded: the tab, the mode or the workspace may have moved meanwhile, and every one of
  // those hides the button. A menu for a control that is no longer there is not opened.
  if ($('rxpick').style.display === 'none') return;
  const items = list || [];
  menu.innerHTML = items.map((x, i) => `<button data-rx="${escA(i)}"><span>${esc(x.name)}</span><span class="rxpat">${esc(x.pattern)}</span></button>`).join('')
    + `<button class="rxman" data-man="1">${list === null ? 'The saved patterns could not be read. ' : (items.length ? '' : 'No saved patterns yet. ')}Manage\u2026</button>`;
  menu.querySelectorAll('[data-rx]').forEach((b) => {
    b.onclick = () => {
      menu.classList.remove('show');
      // The same guard as above, one interaction later: a pattern applied into a view whose search
      // no longer offers regex would filter names by a literal `\\b\\d{18}\\b`.
      if ($('rxpick').style.display === 'none') return;
      const x = items[+b.dataset.rx];
      $('find').value = x.pattern;
      if (!regexMode) { regexMode = true; $('rxmode').classList.add('on'); }
      render();
    };
  });
  menu.querySelector('[data-man]').onclick = () => { menu.classList.remove('show'); openSettings('#rx'); };
  const r = $('rxpick').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.classList.add('show');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#rxmenu') && !e.target.closest('#rxpick')) $('rxmenu').classList.remove('show');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('rxmenu').classList.remove('show'); });

$('findclear').onclick = () => { $('find').value = ''; render(); $('find').focus(); };
$('typesel').onchange = () => { typeFilter = $('typesel').value || null; render(); };
$('sort').onchange = () => { sortKey = $('sort').value; render(); };
$('sortdir').onclick = () => { sortDir = -sortDir; $('sortdir').innerHTML = sortDir === 1 ? '&#8593;' : '&#8595;'; render(); };
$('graph').onclick = () => openSchemaGraph();
$('export').onclick = () => doExport('html');
$('exportmd').onclick = () => doExport('md');
$('retry').onclick = retryFailed;
$('refresh').onclick = refreshLocal;
$('health').onclick = () => ($('healthview').classList.contains('show') ? closeHealth() : (closeAI(), openHealth()));
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
$('pspFull').onclick = () => { expScope = Object.assign({}, SCOPE_FULL); scopeToUI(); };
$('pspSafe').onclick = () => { expScope = Object.assign({}, SCOPE_SAFE); scopeToUI(); };
SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.onchange = scopeFromUI; });
$('opts').onclick = () => openSettings();
$('about').onclick = showAbout;
$('aboutx').onclick = closeAbout;
$('aboutok').onclick = closeAbout;
$('scrim').onclick = () => { closeAbout(); closeScope(false); };
// Closing the pane does not forget where you have been: reopening anything continues the chain.
$('dclose').onclick = () => { detailLoad++; $('detail').classList.remove('show'); $('resizer').classList.remove('show'); selectedId = null; updateNav(); render(); };
document.querySelectorAll('.dtab').forEach((b) => {
  b.onclick = async () => {
    if (b.disabled) return;
    const mine = ++detailLoad, op = beginWorkspaceOp();
    detailTab = b.dataset.tab;
    document.querySelectorAll('.dtab').forEach((x) => x.classList.toggle('active', x === b));
    const v = viewById().get(selectedId);
    if (v) { await renderDetail(v, mine, op); if (detailCurrent(mine, op)) resetDetailScroll(); }   // a different tab is different content too
  };
});
// A stored folder handle loses its permission between sessions and can only be re-granted from a
// user gesture. Any click in the panel counts, so the first thing the user does restores access -
// except on the controls that would themselves ask, on a dialog, on the mismatch overlay, or in the
// chat. The two panels excluded different subsets of those and neither list was wrong, which is how
// a divergence survives: both looked deliberate. It is the union now, and the same on both sides.
document.addEventListener('click', async (e) => {
  if (!root || rootGranted) return;
  const t = e.target;
  if (t.closest && (t.closest('#wsroot') || t.closest('#pfoot') || t.closest('.dlg') || t.closest('#aiview') || t.closest('#offoverlay'))) return;
  try { if (await ensurePerm(root)) { rootGranted = true; await refreshWorkspaces(); } } catch (_) {}
}, true);

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
  try { chrome.storage.local.set({ detailH: $('detail').style.height }); } catch (_) {}
});

chrome.tabs.onActivated.addListener(() => refreshContext());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete' || info.url) refreshContext(); });
window.addEventListener('focus', () => refreshContext());

(async () => {
  try { const r = await chrome.storage.local.get('detailH'); if (r && r.detailH) $('detail').style.height = r.detailH; } catch (_) {}
  await loadScope(); await loadZohoDc(); await restoreRoot(); await refreshContext();
})();
$('help').href = DOCS_URL;   // set here, not in the markup - same as the CRM panel
