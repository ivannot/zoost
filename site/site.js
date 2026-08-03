/*
 * site.js — progressive enhancement for zoost.it. The pages are complete without it: this only
 * fills in things that cannot be known when the HTML is written. If it does not run, or the API is
 * unreachable, nothing breaks and nothing misleading is left on screen.
 */
(function () {
  'use strict';

  // Copyright year. A notice reads as the year of publication, so the first year stays fixed and a
  // range appears only once the current year is actually later — "Copyright 2027" alone on work
  // published in 2026 would be less accurate, not more.
  var FIRST_YEAR = 2026;
  var now = new Date().getFullYear();
  var years = now > FIRST_YEAR ? FIRST_YEAR + '–' + now : String(FIRST_YEAR);
  Array.prototype.forEach.call(document.querySelectorAll('.cyear'), function (el) { el.textContent = years; });

  // One request feeds two independent things: the footer badge and the guide's "covers" stamp.
  // Either may be absent on a given page, so neither is allowed to be the other's precondition.
  var box = document.getElementById('vers');
  var stamp = document.querySelector('.upd .dv, .upd .dd');
  if ((!box && !stamp) || !window.fetch) return;

  function fmtDate(iso, longMonth) {
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: longMonth ? 'long' : 'short', year: 'numeric' });
  }

  // "Covers Zoost X · updated Y" on the guide. Kept in step with the repo automatically: the rule is
  // that documentation ships with the code that changed it, so the version the docs describe is the
  // version in the manifest. The date is the last change to docs.html specifically — using the whole
  // site would claim the guide was updated when only the homepage moved.
  // "Covers Zoost X · updated Y" on a guide. Which product's version, and which file's date, come
  // from the .upd element itself — a guide that borrowed the other product's number would be stating
  // something false about the thing it documents.
  function fillDocsStamp(d) {
    var el = document.querySelector('.upd');
    if (!el) return;
    var app = el.getAttribute('data-app') || 'crm';
    var v = el.querySelector('.dv');
    var t = el.querySelector('.dd');
    var ver = (d[app] && d[app].repo) || (app === 'crm' ? d.repo : null);
    if (v && ver) v.textContent = ver;
    var when = el.getAttribute('data-updated-key') === 'analytics' ? d.docsAnalyticsUpdated : d.docsUpdated;
    if (t && when) { var f = fmtDate(when, true); if (f) t.textContent = f; }
  }

  fetch('/api/versions', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      fillDocsStamp(d);
      if (!box) return;
      var bits = [];
      // Three different things on purpose: what you can install, what has been released, and what is
      // being built. "In development" is spelled out so the last one cannot be read as available.
      // One line per product, each naming itself. Two published extensions and a single unqualified
      // "Web Store 0.13.8" would read as covering both. Falls back to the old flat fields so a page
      // served from cache before the endpoint changed still shows something true.
      var prods = [['Zoho CRM', d.crm || { store: d.store, repo: d.repo }], ['Zoho Analytics', d.analytics]];
      prods.forEach(function (pr) {
        var name = pr[0], v = pr[1];
        if (!v || (!v.store && !v.repo)) return;
        if (bits.length) bits.push('<span class="vbreak"></span>');
        bits.push('<span class="vitem vprod">' + esc(name) + '</span>');
        bits.push('<span class="vitem"><b>Web Store</b> ' + (v.store ? esc(v.store) : '<i>unknown</i>') + '</span>');
        if (v.repo) bits.push('<span class="vitem"><b>In development</b> ' + esc(v.repo) + '</span>');
      });
      if (bits.length) bits.push('<span class="vbreak"></span>');
      bits.push('<span class="vitem"><b>Latest tag</b> ' + (d.tag ? esc(d.tag) : '<i>unknown</i>') + '</span>');
      if (d.siteUpdated) {
        var f = fmtDate(d.siteUpdated);
        if (f) bits.push('<span class="vitem"><b>Site updated</b> ' + esc(f) + '</span>');
      }
      box.innerHTML = bits.join('');
      box.classList.add('on');
    })
    .catch(function () { /* the badge simply does not appear */ });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
})();
