/*
 * reportshell.js - the shape of an exported report, shared by both products.
 *
 * **The foot is one line.** It carried the attribution, a per-product notice and the legal
 * disclaimer, and it was got wrong three times in one afternoon. It says what made the report and
 * links to the site, on the author's instruction, and nothing else.
 *
 * **Two reports from one maker were two different documents.** Measured on 24 August: the Zoho CRM
 * one was 517 lines with a sticky header and a live filter, a grouped index with counts, cards per
 * item, 20 internal anchors and three declared empty states; the Zoho Analytics one was 81 lines
 * with a flat list of links and one anchor. Every difference found that day - the footer band, the
 * uncoloured SQL, the missing attribution - was a symptom of that, and each was patched on its own
 * while the next one waited. Reported, in the words that decide this file: «I want these products to
 * bereal twins, not because you wrote it in a file you keep ignoring.»
 *
 * So the shape is not written twice. This file holds the stylesheet, the header, the index, the card
 * an item is drawn in, the declared empty state, the foot and the filter script; each product brings
 * only its own chapters, its own rows and its own accent. It is byte-identical in both apps and
 * `tests/tools_test.py` compares the two copies - the arrangement `graphlogic.js` already uses for
 * what the two diagram windows compute, for the same reason: a second copy is a second place to
 * drift, and drift is what this file was written to end.
 *
 * Copied, not imported: MV3 pages load classic scripts and this project has no build step, so the
 * two apps each carry a copy and a test makes them the same file.
 */
'use strict';

const REPORT_CSS = `

:root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:14px 0;z-index:5}
/* The band spans the window and its content sits in the same 1000px column the sections do -
   the foot already worked this way and the head did not, so the title started at the window's
   edge while the first chapter began 140px further in. Two rules that are meant to line up and
   only one of them written down is how they came apart. */
header>.hcol{max-width:1000px;margin:0 auto;padding:0 20px}
header h1{margin:0 0 4px;font-size:20px;display:flex;align-items:center;gap:10px}
h1 .mark{width:24px;height:24px;flex:0 0 auto;border-radius:6px}.meta{color:var(--muted);font-size:13px;font-family:ui-monospace,monospace}
.credit{margin-top:6px;color:#94a3b8;font-size:12px}.credit a{color:var(--accent)}
#q{margin-top:10px;width:100%;max-width:520px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px}
main{max-width:1000px;margin:0 auto;padding:24px 20px 80px}
h2{font-size:16px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);border-bottom:2px solid var(--line);padding-bottom:6px;margin:36px 0 10px}
h3.grp{font:12px ui-monospace,monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:22px 0 8px}
h3.grp .cnt{color:#9aa4b2}
.item{border:1px solid var(--line);border-radius:10px;background:#fff;margin:10px 0;overflow:hidden}
/* A box whose content is wider than it is scrolls; it never clips and never spills. Code and
   tables are the two that exceed - a query with a long expression, a table with a long API
   name - and both are inside a card that must not cut them off. */
.refs{overflow-x:auto}
.ih{padding:9px 12px;border-bottom:1px solid var(--line);background:#fbfcfe;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ih b{font-size:14px}.ih code{background:#eef1f5;padding:1px 6px;border-radius:5px;font-size:12px;color:#2563eb}
.ih .gen{color:#8b5cf6;font:12px ui-monospace,monospace}
/* Every anchor target clears the sticky header. A jump puts the target at the top of the window,
   which is *under* the band, so the reader lands a few lines into the section with its heading
   hidden - reported on both reports. Only .item had 120px and nothing else had anything, and a
   number here would be wrong for the other product anyway: the two headers are different
   heights, and either gains a line the day somebody adds one. So the height is measured at
   load and on resize, and this is only the fallback for a reader with no script. */
[id]{scroll-margin-top:calc(var(--stick, 120px) + 14px)}
.refs{padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;display:flex;flex-direction:column;gap:3px;background:#fcfdff}
/* **Every link in the document looks like a link.** This was written per context - the
   reference lines, the first column of a table, the index, the workflow actions - so a link
   put anywhere else rendered as ordinary black text and there was no way to tell what was
   clickable. One of the two reports gained cross-references that landed in exactly those
   places, and they arrived invisible.
   One rule for the whole body, so the next place a link is written is covered by having
   Underlined and not only coloured: colour alone is not an affordance for a reader who does
   not see this one, and a report is a document that gets sent to people we know nothing
   about. */
/* A name and what kind of thing it is are two facts, and run together with a space between
   them they read as one - a list of forty of those is unreadable, which is the word that was
   used. The kind is separated and muted, so the eye finds the names. */
main li .ty{color:var(--muted);font-style:italic}
main li .ty:before{content:' \u00b7 ';font-style:normal}
main a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
.refs .none{color:#9aa4b2}
.badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;text-transform:uppercase}
.badge.rest{background:#ede9fe;color:#6d28d9}.badge.no{background:#fef3c7;color:#92400e}
pre.code{margin:0;padding:12px 14px;background:#0f1622;color:#cbd5e1;font:12.5px/1.55 ui-monospace,monospace;white-space:pre;overflow:auto}
.c-com{color:#5b6b82;font-style:italic}.c-str{color:#7ee0a6}.c-num{color:#e0a86b}.c-kw{color:#7aa2f7;font-weight:600}.c-type{color:#c792ea}.c-fn{color:#82d2ff}
table.ftbl{width:100%;border-collapse:collapse;font:12.5px ui-monospace,monospace}
.item>table.ftbl{display:block;overflow-x:auto}
.ftbl th{background:#f6f8fb;color:var(--muted);text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase}
.ftbl td{padding:5px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
/* The first column used to be painted the accent colour whether or not its cell was a link, so
   in a table where some names are linked and some are not - which is every table in one
   report - the colour said nothing and there was no way to see what was clickable.
   The colour belongs to the anchor, not to the column. */
.ftbl td.mono{font-family:ui-monospace,monospace}
/* The card has to contain its table. A table set to the full width of the card still cannot shrink
   below its columns' minimum content, so one long API name - and a Deluge org is full of them -
   pushed the rows out past the white background, which then ended in the middle of the data.
   Two halves: the long identifiers wrap instead of forcing the width, and the card scrolls if
   something still will not fit, rather than spilling out of itself. */
.toc{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:16px 0;overflow-x:auto}
.toc>h2{margin:0 0 8px;border:0;padding:0}
.toch{font-size:13px;margin:14px 0 6px;color:var(--ink);text-transform:none;letter-spacing:0}
.toctbl{width:100%;border-collapse:collapse;font:12.5px system-ui,-apple-system,sans-serif}
.toctbl th{text-align:left;padding:5px 8px;border-bottom:2px solid var(--line);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.3px}
.toctbl td{padding:4px 8px;border-bottom:1px solid var(--line)}
.toctbl td.mono{font-family:ui-monospace,monospace;color:var(--muted);font-size:11.5px;overflow-wrap:anywhere}
.toctbl td.ct{text-align:center}
.toctbl tbody tr:hover{background:#f6f8fb}
.toctbl .none{color:#9aa4b2;text-align:center}
.wfxcond{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0;background:#fbfcff}
.wfxc{color:#2563eb;font-size:11px;font-weight:600;margin-bottom:4px}
.wfxcrit{font:12px ui-monospace,monospace;color:var(--ink);margin-bottom:4px}.wfxcrit i{color:var(--muted)}
.wfxact{font-size:12px;margin:3px 0}.wfxact b{color:var(--muted);font-weight:600;margin-right:4px}
.wfact-x{display:inline-block;background:#eef1f5;color:var(--muted);border-radius:5px;padding:1px 6px;margin:1px 3px 0 0;font-size:11px}
.hxcov{font-size:12px;color:var(--muted);line-height:1.6;background:#f6f8fc;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0 14px}
.hxsec{margin:12px 0}.hxsec h3{font-size:13px;margin:0 0 3px;display:flex;align-items:center;gap:8px}
.hxn{font:11px ui-monospace,monospace;padding:1px 8px;border-radius:10px}
.hxn.warn{background:#fdf0d5;color:#8a5a12}.hxn.bad{background:#fbe0e0;color:#b42318}.hxn.ok{background:#d9f3e6;color:#177a4a}
.hxd{font-size:11.5px;color:var(--muted);margin:0 0 6px}
/* Three paragraphs in this report carry class="note" - the withheld sender addresses, the freshness
   of the failures reading - and the class was defined nowhere, so the lines meant to stand out
   rendered as ordinary body text. The same defect as .k / .card / .note / b.ui on the site, and
   csscheck cannot see it: this stylesheet is a template literal inside a .js file, which is also why
   no backtick may appear in this comment. */
.note{color:#8a5a00;background:#fff8e6;border:1px solid #e5c76b;border-radius:6px;padding:8px 10px;font-size:13px;margin:8px 0}
.hxrow{padding:3px 8px;border:1px solid var(--line);border-radius:6px;margin:2px 0;font:12px ui-monospace,monospace}
.hxrow .hxm{color:var(--muted);font-size:11px}
.hxnone{font-size:11.5px;color:#177a4a;margin:0}
.tochx{font-size:12px;margin:2px 0 6px}
.empty{color:var(--muted)}
footer{border-top:1px solid var(--line);background:#fff;padding:14px 0;color:var(--muted);font-size:12px}
footer>.fcol{max-width:1000px;margin:0 auto;padding:0 20px}
footer a{color:var(--accent)}

tr.relrow.sys td{color:#9aa4b2;background:#fbfbfc}

`;

/** The product's own mark, inline, so a reader can see at a glance which extension wrote this.
 *
 * Asked for in exactly those words: an export of a Zoho CRM org and one of a Zoho Analytics workspace
 * are different documents, and the first thing that says so should not be a sentence you have to
 * read. It is the same geometry as the extension's icon - one stroked path, the numbers 33 and 95 -
 * with only the tile colour differing, which is what the two icons themselves differ by.
 *
 * Inline rather than a file: the report is one self-contained document that has to open from a
 * folder with nothing beside it. The colour is the one thing a caller passes, and it is checked
 * against a hex literal *and* escaped on the way out - it reaches an attribute, and the rule
 * here is that nothing reaches an attribute unescaped, however ours the value looks today and
 * however narrow the check above it. `htmlcheck` reads it that way too, which is the point of
 * having it: a validated value and an escaped one are two different arguments, and the tool
 * can only see the second.
 */
function reportMark(tile) {
  const c = /^#[0-9a-f]{6}$/i.test(String(tile || '')) ? tile : '#2563eb';
  return `<svg class="mark" viewBox="0 0 128 128" aria-hidden="true">`
    + `<rect x="6" y="6" width="116" height="116" rx="30" fill="${escReportA(c)}"/>`
    + `<path d="M 33 33 L 95 33 L 33 95 L 95 95" fill="none" stroke="#fff" stroke-width="18" `
    + `stroke-linecap="square" stroke-linejoin="round"/></svg>`;
}

/** The head of a report: **the subject**, what it was read from, and the filter that searches it.
 *
 * The subject is the org or the workspace this report is about - never the product that wrote it.
 * One builder passed the workspace's own name and the other passed «Zoost - workbench for Zoho CRM -
 * Export», so a shared header was two ideas wearing one function: a reader opening both saw one
 * report about their org and one about the tool. The tool is named once, in the foot. A parameter
 * called `title` accepts anything; one called `subject` says what the answer has to be, and the case
 * beside it refuses a builder that passes its own name.
 *
 * The filter was a Zoho CRM feature and Analytics had none, which on a report of a few hundred views
 * is the difference between a document you can use and one you scroll. It is part of the shape now.
 */
function reportHead(subject, metaLines, filterPlaceholder, made) {
  return `<header><div class="hcol"><h1>${reportMark(made.tile)}${escReport(subject)}</h1>`
    + metaLines.filter(Boolean).map((m) => `<div class="meta">${m}</div>`).join('')
    // Written here, not by the caller, so the two reports cannot say it differently or one of them
    // not at all. One carried «exported 2026-08-24 by Zoost - workbench for Zoho Analytics v1.29.0»
    // and the other said nothing about when it was made or by what version - which is the first
    // thing somebody reading a report of an org they do not administer wants to know. The date's
    // format is decided here too, for the same reason.
    // Date **and** time: two exports of one org on one day are two documents, and a date alone
    // cannot tell them apart - which is exactly when somebody is comparing them.
    + `<div class="meta">exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by `
    + `${escReport(made.name)} v${escReport(made.version)}</div>`
    + (filterPlaceholder
      ? `<input id="q" placeholder="${escReportA(filterPlaceholder)}" oninput="filt()">`
      : '')
    + `</div></header>`;
}

/** The index: one group per chapter, each with its count and its own rows.
 *
 * A flat list of links says how many chapters there are; this says how much is in each, which is the
 * first question anybody opening a report of somebody else's org actually has.
 */
function reportToc(groups) {
  const live = groups.filter((g) => g && g.title);
  return `<nav class="toc"><h2>Contents</h2>`
    + live.map((g) => `<h3 class="toch">${escReport(g.title)}`
      + (g.count === undefined ? '' : ` <span class="cnt">${g.count}</span>`)
      + `</h3>`
      + (g.rows && g.rows.length
        ? `<table class="toctbl"><tbody>${g.rows.map((r) => `<tr><td><a href="#${escReportA(r.href)}">`
          + `${escReport(r.label)}</a></td>${(r.cells || []).map((c) => `<td class="mono">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : `<div class="tochx"><a href="#${escReportA(g.href || '')}">${escReport(g.note || 'Go to')}</a></div>`))
      .join('')
    + `</nav>`;
}

/** One item, in the card both reports draw them in: a header line, an optional block of
 *  cross-references, and whatever the product puts in the body. */
function reportItem(o) {
  return `<section class="item" id="${escReportA(o.anchor)}" data-name="${escReportA((o.search || o.name || '').toLowerCase())}">`
    + `<div class="ih"><b>${escReport(o.name)}</b>`
    + (o.code ? ` <code>${escReport(o.code)}</code>` : '')
    + (o.badges || '')
    + `</div>`
    + (o.refs ? `<div class="refs">${o.refs}</div>` : '')
    + (o.body || '')
    + `</section>`;
}

/** «Nothing here» and «you left it out» are different facts, and a report that shows the same blank
 *  for both makes the reader guess which. Both products say which now. */
function reportAbsent(asked, what) {
  return asked
    ? `<p class="empty">No ${escReport(what)}.</p>`
    : `<p class="empty">Not included in this export - ${escReport(what)} were unticked when it was made.</p>`;
}

/** The foot: one line, the product's name linked to its site, and nothing else.
 *
 * It used to carry the author, the sponsor links, a per-product notice and the legal disclaimer, and
 * it was got wrong three times in one afternoon. What a reader of somebody else's report needs from
 * a foot is one fact - what made this - and everything else was chrome that had to be maintained.
 */
function reportFoot(name, url) {
  return `<footer><div class="fcol">Generated by `
    + (url ? `<a href="${escReportA(url)}">${escReport(name)}</a>` : escReport(name))
    + `</div></footer>`;
}

/** The live filter, as a string because it is written into the document rather than run here. */
/** The filter box, and what it is allowed to promise.
 *
 * It used to hide elements carrying a `data-name` attribute, which some rows had and most of the
 * document did not - so it filtered a few tables, left every list and every other table alone,
 * and nothing on screen said which. Reported in one sentence - you cannot tell what it acts on,
 * some things it filters and others it does not - with the right conclusion attached: a control
 * nobody can predict is worse than no control.
 *
 * So the rule is now one sentence a reader can hold: **it hides any row, list entry or card that
 * does not contain what you typed**, judged on the text you can see rather than on an attribute
 * somebody remembered to add. The index is left alone - it is how you get around while filtering,
 * and emptying it would take the map away at the moment it is needed.
 */
const REPORT_FILTER_JS = "function filt(){var q=document.getElementById('q').value.trim().toLowerCase();var els=document.querySelectorAll('main tbody tr, main li, main .item');for(var i=0;i<els.length;i++){var e=els[i];if(e.closest('.toc')){continue;}e.style.display=(!q||(e.textContent||'').toLowerCase().indexOf(q)>=0)?'':'none';}}"
  // The sticky band's real height, measured at load and on resize. A jump puts its target at
  // the top of the window, which is under the band, so without this the reader lands a few
  // lines into the section with its heading hidden - and a constant would be wrong for the
  // other product, whose header is a different height, and wrong again the day either gains a
  // line.
  + "function stick(){var h=document.querySelector('header');"
  + "if(h)document.documentElement.style.setProperty('--stick',h.offsetHeight+'px');}"
  + "addEventListener('resize',stick);stick();";

// The two escapers this file needs, named for it. Each product has its own - `esc`/`escHtml` in one,
// `esc2` in the other - and reaching for whichever happens to exist is how a shared file stops being
// shareable. `htmlcheck` reads the names to know an attribute is escaped, so both are explicit.
function escReport(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escReportA(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
