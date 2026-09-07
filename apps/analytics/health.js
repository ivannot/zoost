/*
 * health.js - the Analytics audit model, rendering and view controls.
 *
 * A classic script loaded before sidepanel.js. It reads the local mirror through the existing
 * panel helpers and exposes the same open/close surface used by the panel wiring.
 */
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
// `#health.on` is in this panel's own stylesheet and nothing ever set it, so the audit button stayed
// unlit while the AI button beside it lights - the rule was dead CSS and the twin did it right.
function openHealth() { closeOverview(); renderHealth(); document.body.classList.add('health-open'); $('healthview').classList.add('show'); $('health').classList.add('on'); }
function closeHealth() { document.body.classList.remove('health-open'); $('healthview').classList.remove('show'); $('health').classList.remove('on'); }
