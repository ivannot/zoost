/*
 * export.js - Analytics HTML and Markdown report builders and their file writers.
 *
 * A classic script loaded before sidepanel.js. Report data still comes through the panel's local
 * mirror adapters; this file owns only assembly and export behaviour.
 */
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
// Which build wrote a stored preference - declared before the default that stamps itself with it,
// because a `const` used above its declaration throws at load. See the twin for the defect this
// closes: only the *reader* was writing the stamp, so ticking the sensitive section and exporting
// wrote a scope with none, and the next load read that as pre-migration and turned it back off.
const SCOPE_SV = 2;
const SCOPE_DEFAULT = Object.assign({}, SCOPE_FULL, { sql: false, sv: SCOPE_SV });
let expScope = Object.assign({}, SCOPE_DEFAULT);
// What the dialog is editing right now, kept apart from the stored preference for the reason the twin
// records: this dialog saves what you leave it with, so editing the stored value in place meant
// **Cancel did not cancel** - tick «Everything», press Cancel, and the SQL box was ticked when it
// reopened, and stored by the next export. That box is the one §4.3 of the privacy policy names as
// the sensitive half of an Analytics export, which is why it starts unticked and why a transient
// tick must never become a stored preference.
let dlgScope = Object.assign({}, SCOPE_DEFAULT);
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
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) e.checked = !!dlgScope[k]; });
  const q = $('sc_sql'); if (q) q.disabled = !dlgScope.structure;
  $('scwarn').textContent = dlgScope.sql ? '\u26a0 includes the full SQL of every query table' : '';
}
function scopeFromUI() {
  SCOPE_KEYS.forEach((k) => { const e = $('sc_' + k); if (e) dlgScope[k] = !!e.checked; });
  if (!dlgScope.structure) dlgScope.sql = false;
  scopeToUI();
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
    // The dialog opens on a copy of what is stored; nothing it does touches the stored value
    // until the reader presses Export.
    dlgScope = Object.assign({}, expScope);
    _scopeResolve = resolve; scopeToUI();
    $('scrim').classList.add('on'); panelInert(true); $('expscope').classList.add('on');
  });
}
function closeScope(ok) {
  $('scrim').classList.remove('on'); panelInert(false); $('expscope').classList.remove('on');
  const r = _scopeResolve; _scopeResolve = null;
  // Export takes what the dialog holds and *then* it becomes the preference; Cancel takes nothing.
  if (ok) expScope = Object.assign({}, dlgScope);
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

/** When each part of this mirror was last read, per area - the line the other product's report has
 *  carried since it existed. A report that says «exported today» while a third of it is two weeks old
 *  is the half-truth this project refuses; the reader gets the fact and decides what it means.
 *
 *  The dates come from what the pull wrote beside the data, so an area nobody has pulled says so
 *  rather than borrowing the newest one. */
/** True when what is on disk was written by a pull older than the current capture schema. */
function mirrorIsOlderThanSchema() {
  return !!bound && !bound.sample && Number(bound.sv || 0) < PULL_SV;
}

function analyticsFreshness() {
  const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : 'never read');
  const parts = [
    // `views.json` carries its own date; the rest of the mirror is written by the same pull, so
    // the config's `lastPull` is what they can honestly claim. Nothing here invents a per-area date
    // the disk does not hold.
    ['Views', viewsPulledAt || (bound && bound.lastPull)],
    ['Structure', bound && bound.lastPull],
    ['Lineage', bound && bound.lastPull],
  ];
  return parts.map(([what, iso]) => `${what} as of ${day(iso)}`).join(' \u00b7 ');
}

function exportSections(sc) {
  const m = viewById();
  const h = healthFindings();
  const out = [];
  if (sc.views) out.push({ id: 'views', title: 'Views', rows: views.map((v) => [v.name, v.type, v.folderName || '—', v.owner || '—', v.designModifiedAt ? shortDate(v.designModifiedAt) : (v.designModifiedText || '—'), shortDate(v.dataModifiedAt), v.system ? 'system' : '']),
    head: ['View', 'Type', 'Folder', 'Owner', 'Design', 'Data', ''], links: [0] });
  if (sc.structure) out.push({ id: 'structure', title: 'Structure', tables: Object.entries(schema).map(([id, t]) => ({ id, ...t })) });
  if (sc.relations) out.push({ id: 'relations', title: 'Relations', rows: relations.map((r) => [r.sourceName, r.targetName, r.relation]), links: [0, 1], head: ['From', 'To', 'Join'] });
  if (sc.sql) out.push({ id: 'sql', title: 'Query table SQL' });
  if (sc.lineage && deps) out.push({ id: 'lineage', title: 'Lineage', rows: views.filter((v) => deps[v.id]).map((v) => [v.name, String(deps[v.id].parents.length), String(deps[v.id].children.length), String(deps[v.id].dashboards.length)]), head: ['View', 'Reads from', 'Read by', 'On dashboards'], links: [0] });
  if (sc.health) out.push({ id: 'health', title: 'Health', h });
  return out;
}

async function buildExportHtml(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const esc2 = esc;
  // The contents the shell draws, which is the one the other product has had all along: a card
  // with a group per chapter and how much is in each. This was a flat two-column list of
  // titles - it said how many chapters there are and nothing about how much is in them, which
  // is the first question anybody opening somebody else's report actually has.
  const toc = reportToc(secs.map((x) => ({
    title: x.title,
    count: x.rows ? x.rows.length : x.tables ? x.tables.length : undefined,
    href: x.id,
    note: `Go to ${x.title}`,
  })));
  // **A report about lineage you cannot click through is not a report about lineage.** The other
  // product's report carries twenty internal anchors - a function to what it calls, to the module
  // it reads, to the rule that fires it - and this one carried exactly one, the contents. Every
  // view named anywhere in the document now points at where that view is described; a name that
  // belongs to no view in this export stays plain text rather than becoming a link to nothing.
  const vAnchor = (id) => 'v-' + String(id).replace(/[^\w.-]+/g, '_');
  // **The SQL chapter needs its own.** Both chapters headed a query table with `v-<id>`, so every
  // one of them carried two identical anchors and every link in the document landed on the first -
  // the Structure heading. The chapter the reader ticked, and the one flagged as sensitive, had no
  // working link into it from anywhere. Invisible with SQL unticked, because then there is only one.
  const sqlAnchor = (id) => 'sql-' + String(id).replace(/[^\w.-]+/g, '_');
  const byName = new Map(views.map((v) => [v.name, v.id]));
  // **Which anchors this document will actually contain**, derived from `secs` - the same list the
  // loop below draws from - rather than from the org. The first version linked any name that was a
  // view, and a view is not a section: only tables and query tables get a heading of their own, so
  // every report and dashboard named in a table cell or in a health list became `#v-<id>` pointing
  // at nothing. Reported from a real workspace, with the dead link pasted in.
  //
  // It is the same shape as everything else today: one value stood for two things - «is in the org»
  // and «is in this report» - and they part company as soon as a chapter is unticked, which is a
  // second way to produce the identical defect. A link that goes nowhere is worse than plain text,
  // because the reader clicks it and concludes the document is broken.
  const anchored = new Set();
  for (const x of secs) {
    if (x.tables) for (const t of x.tables) anchored.add(vAnchor(t.id));
    else if (x.id === 'sql') for (const v of views) if (v.type === 'QueryTable') anchored.add(sqlAnchor(v.id));
  }
  // Structure first, because that is where a reader wants to land; the SQL heading when Structure
  // was unticked and the SQL chapter is the only one that has a heading for that query table.
  // Registering the SQL chapter's tables under the *structure* anchor made every such link live
  // and pointing at nothing in exactly that combination.
  const vLink = (name) => {
    const id = byName.get(name);
    const a = id === undefined ? null : [vAnchor(id), sqlAnchor(id)].find((x) => anchored.has(x));
    return a ? `<a href="#${escA(a)}">${esc2(name)}</a>` : esc2(name);
  };
  // `links` names the columns that hold a view's name, so those cells become links and every
  // other cell stays escaped text. Declared per table rather than guessed from the content: a
  // column of owners must not turn into links because somebody is named like a view.
  const tbl = (head, rows, links) => `<table class="ftbl"><thead><tr>${head.map((h2) => `<th>${esc2(h2)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr data-name="${escA(String(r[0] || '').toLowerCase())}">${r.map((c, i) => `<td${i ? '' : ' class="mono"'}>${links && links.includes(i) ? vLink(String(c)) : esc2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let body = '';
  for (const x of secs) {
    body += `<h2 id="${escA(x.id)}">${esc2(x.title)}</h2>`;
    if (x.rows) body += tbl(x.head, x.rows, x.links);
    else if (x.tables) body += x.tables.map((t) => `<section class="qsec" data-name="${escA(String(t.name || '').toLowerCase())}"><h3 id="${escA(vAnchor(t.id))}">${esc2(t.name)} <small>${esc2(t.kind)}${t.system ? ' · system' : ''}</small></h3>` + tbl(['Column', 'Type', 'References'], t.columns.map((c) => [c.name, c.type, fkText(t.id, c.name)])) + '</section>').join('');
    else if (x.id === 'sql') {
      for (const v of views.filter((v2) => v2.type === 'QueryTable')) {
        // Skipping an unread query made the export silently smaller than the workspace: a reader
        // cannot tell a query that was dropped from one that never existed. The heading is always
        // there; what varies is whether the source or the reason sits under it.
        const st = await sqlReadState(v.id, op);
        // Wrapped, so the filter box can hide it: the report's filter selects rows, entries and
        // sections, and a bare `<h3>` + `<pre>` is none of those - every SQL block stayed on screen
        // through a search that had emptied the tables around it.
        if (st.kind === 'unread') { body += `<section class="qsec" data-name="${escA(String(v.name || '').toLowerCase())}"><h3 id="${escA(sqlAnchor(v.id))}">${esc2(v.name)}</h3><p class="note">Its SQL could not be read (${esc2(st.error)}) - Retry failed / Pull all fetches it.</p></section>`; continue; }
        // Highlighted, like the panel and like the CRM's own report, which has coloured its Deluge
        // since it existed. This one printed plain escaped text: the same query, in two places, one
        // of them readable - and the report is the copy that goes to somebody without the extension,
        // so it is the one that could least afford to be the lesser of the two.
        // `highlightSql` tokenises the raw text and escapes every piece itself, which is the only
        // reason it may be handed to innerHTML at all; the placeholder for «not read» is not SQL and
        // stays on `esc2`.
        const has = st.body != null && st.body.trim();
        body += `<section class="qsec" data-name="${escA(String(v.name || '').toLowerCase())}"><h3 id="${escA(sqlAnchor(v.id))}">${esc2(v.name)}</h3><pre class="${has ? 'code' : 'note'}">`
          + `${has && window.highlightSql ? window.highlightSql(st.body) : esc2(sqlText(st.body))}</pre></section>`;
      }
    } else if (x.h) {
      const H = x.h;
      body += `<p><b>${H.counts.views}</b> views · <b>${H.counts.folders}</b> folders · <b>${H.counts.tables}</b> tables · <b>${H.counts.columns}</b> columns · <b>${H.counts.relations}</b> relations · <b>${H.counts.sql}</b> SQL</p>`
        + `<p class="gap">Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.</p>`
        + `<h3>Nothing depends on them (${H.orphans ? H.orphans.length : '—'})</h3><p class="gap">Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.</p>`
        + (H.orphans ? `<ul>${H.orphans.map((v) => `<li>${vLink(v.name)}<span class="ty">${esc2(v.type)}</span></li>`).join('')}</ul>` : '')
        + `<h3>Tables in no relation (${H.islands.length})</h3><ul>${H.islands.map((t) => `<li>${vLink(t.name)}<span class="ty">${esc2(t.kind)}</span></li>`).join('')}</ul>`
        + `<h3>Put there by Zoho, not by you (${H.system.length})</h3><ul>${H.system.map((v) => `<li>${vLink(v.name)}</li>`).join('')}</ul>`
        // **The other two the panel shows.** `undescribed` and `noStructure` were computed and read
        // by the panel alone, so an export was short by two of the six lists - and the panel's own
        // list helper writes «…and N more. The full list is in the exports.» over a section the
        // exports did not contain. The CRM twin writes all seven of its sections through one helper.
        + `<h3>No description (${H.undescribed.length} of ${H.counts.views})</h3><ul>${H.undescribed.map((v) => `<li>${vLink(v.name)}<span class="ty">${esc2(v.type)}</span></li>`).join('') || '<li class="gap">None</li>'}</ul>`
        + `<h3>No structure reachable (${H.noStructure.length})</h3><ul>${H.noStructure.map((v) => `<li>${vLink(v.name)}<span class="ty">${esc2(v.type)}</span></li>`).join('') || '<li class="gap">None</li>'}</ul>`
        + (H.unread.length ? `<h3>Could not be read (${H.unread.length})</h3><ul>${H.unread.map((f) => `<li>${esc2((viewById().get(f.id) || {}).name || f.id)} - ${esc2(f.error)}</li>`).join('')}</ul>` : '');
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zoost - ${esc2(bound.label || bound.name || bound.workspace)}</title><style>${REPORT_CSS}
:root{--accent:#0e9488}
/* What only this report has. Everything else - the frame, the header, the index, the card, the
   tables, the empty state, the foot - is in reportshell.js, byte-identical in both products. This
   tail used to redefine table, th, td, pre and small as well, so the same tables were drawn by two
   stylesheets and the two documents did not look alike however much markup they shared. A rule here
   that the shell already has is a rule that makes them differ. */
.gap{color:var(--muted);font-size:12.5px;border-left:3px solid var(--line);padding-left:10px}
</style></head><body>
${reportHead(bound.label || bound.name || bound.workspace,
             [`${esc2(bound.label || bound.name || '')} \u00b7 ${esc2(bound.workspace)} \u00b7 ${views.length} views \u00b7 ${Object.keys(schema).length} tables \u00b7 ${relations.length} relations \u00b7 contents: ${esc2(SCOPE_KEYS.filter((k) => sc[k]).join(', ') || 'nothing')}${sc.sql ? '' : ' \u00b7 SQL excluded'}`,
              `Data read from Zoho Analytics: ${esc2(analyticsFreshness())}`],
             'Filter - hides any row, entry or card that does not match\u2026',
             // The tile of this product's own icon - see the CRM's report for why.
             { name: PRODUCT_NAME, version: chrome.runtime.getManifest().version, tile: '#be2a6b' })}
<main>${toc}
${body}</main>
${reportFoot(PRODUCT_NAME, PRODUCT_URL)}
<script>${REPORT_FILTER_JS}</script>
</body></html>`;
}

async function buildExportMarkdown(sc, op = beginWorkspaceOp()) {
  const secs = exportSections(sc);
  const row = (r) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';
  let out = `# ${bound.label || bound.name || bound.workspace}\n\nZoho Analytics workspace ${bound.label && bound.name ? `${bound.name} ` : ''}\`${bound.workspace}\` · exported ${new Date().toISOString().slice(0, 10)} by ${PRODUCT_NAME} v${chrome.runtime.getManifest().version}\n\n`;
  // The absolute this project already walked back everywhere else, still shipping inside every
  // Markdown export - `auditcheck` does not read template literals in a builder, so no gate had ever
  // read it. What is claimable is which requests are sent, not what somebody else's server does.
  out += '> Read-only mirror. Every request Zoost sends Zoho Analytics is a read, and it never asks for record data.\n\n';
  // The dialect reference is written **before** the sections, so it is listed before them: the
  // contents used to name it last while the document put it first, which shifted every entry
  // after it by one. And its title is taken from the block itself rather than typed again here -
  // a heading and a contents entry that are two copies of one string is how they came apart.
  const sqlRef = window.ZOHO_ANALYTICS_SQL.markdown();
  const sqlTitle = (sqlRef.match(/^## (.+)$/m) || [, 'Zoho Analytics SQL'])[1];
  out += '## Contents\n\n' + [sqlTitle, ...secs.map((x) => x.title)].map((t) => `- ${t}`).join('\n') + '\n\n';
  // The dialect reference travels with the export on purpose: this file exists to be handed to an
  // agent that has never seen Analytics, and a workspace description without the tool's constraints
  // would get it writing SQL that cannot run.
  out += sqlRef + '\n';
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
      out += `${H.counts.views} views · ${H.counts.folders} folders · ${H.counts.tables} tables · ${H.counts.columns} columns · ${H.counts.relations} relations · ${H.counts.sql} SQL\n\n`;
      out += '> Report definitions are not covered: the endpoint carrying them also carries the computed series, which is your data, so Zoost does not call it.\n\n';
      out += `### Nothing depends on them (${H.orphans ? H.orphans.length : '—'})\n\n> Candidates, not a verdict - a shared link, a scheduled export, an embedded report or an API consumer is invisible to Zoho Analytics' own dependency graph.\n\n`;
      if (H.orphans) out += H.orphans.map((v) => `- ${v.name} (${v.type})`).join('\n') + '\n\n';
      out += `### Tables in no relation (${H.islands.length})\n\n` + H.islands.map((t) => `- ${t.name} (${t.kind})`).join('\n') + '\n\n';
      out += `### Put there by Zoho, not by you (${H.system.length})\n\n` + H.system.map((v) => `- ${v.name}`).join('\n') + '\n\n';
      out += `### No description (${H.undescribed.length} of ${H.counts.views})\n\n` + (H.undescribed.map((v) => `- ${v.name} (${v.type})`).join('\n') || 'None') + '\n\n';
      out += `### No structure reachable (${H.noStructure.length})\n\n` + (H.noStructure.map((v) => `- ${v.name} (${v.type})`).join('\n') || 'None') + '\n\n';
      if (H.unread.length) out += `### Could not be read (${H.unread.length})\n\n` + H.unread.map((f) => `- ${(viewById().get(f.id) || {}).name || f.id} - ${f.error}`).join('\n') + '\n\n';
    }
  }
  // The same line the HTML report's foot carries, and the same the other product's Markdown
  // carries: what made this, and a link to it. One of the two used to say nothing at all.
  out += `\n---\n\nGenerated by [${PRODUCT_NAME}](${PRODUCT_URL})\n`;
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
  // What is stored here is where the dialog **starts next time**, not the scope of the export about
  // to run - which travels in `sc`. So a refused write must not stop the export the reader just
  // asked for, and it must not be silent either. Unguarded, a rejection from IndexedDB threw out of
  // this function before `setBusy`, and the call site discards the promise: the dialog closed, no
  // busy state, no file, no message. The CRM twin says the same thing in the same words, and had
  // the guard; this side did not.
  try { await window.idbHandle.set('exportScopeAnalytics', sc); }
  catch (e) { status(`This export runs with what you ticked; the browser refused to remember it as `
    + `the default (${(e && e.message) || 'no reason given'}).`, 'warn'); }
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
