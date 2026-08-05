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
  var REPO_URL = 'https://github.com/ivannot/zoost';
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
  // version in the manifest. The date is the last change to that guide specifically — using the whole
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
      publishedState(d);
      if (!box) return;
      // One row per product, four aligned columns. Every number here belongs to exactly one
      // extension, so every number is inside a row that names it: with two products published, an
      // unqualified "Web Store 0.13.8 · Latest tag v1.0.0" in a single run does not read as
      // incomplete, it reads as being about whichever product you had in mind.
      //
      // The three are different questions and the labels have to keep them apart: what you can
      // install today, what has been released and can be checked out and verified, and what is
      // being built right now. "In development" is spelled out so it cannot be read as available.
      var bits = [];
      // Our products, named as ours. "Zoho CRM · Web Store 1.0.0" does not read as "the Zoost for
      // Zoho CRM you can install is 1.0.0" — it reads as a statement about Zoho's product, and it
      // is false: 1.0.0 is our version. A label that attributes a property has to name the thing
      // the property belongs to. (A label that merely *selects* a platform — the nav buttons, the
      // guide switcher — may say "Zoho CRM", because there you are choosing a platform.)
      var prods = [
        ['Zoost CRM', d.crm || { store: d.store, repo: d.repo, tag: d.tag }],
        ['Zoost Analytics', d.analytics],
      ];
      prods.forEach(function (pr) {
        var name = pr[0], v = pr[1];
        if (!v || (!v.store && !v.repo)) return;
        // "none yet" rather than "unknown": for a product with no tag those are opposite claims —
        // one says we failed to look, the other is a fact, and it is the fact RELEASES.md states.
        //
        // The tag is a link to its Release, where the archive, its SHA-256 and the two verification
        // commands are. Not to the .zip: a footer that starts a download when clicked is a surprise,
        // and the number beside the file is the point rather than the file. This is the one place
        // the badge stops being a claim and becomes something the reader can check.
        // Three answers to three different questions, in the order a version travels: what you can
        // install today, what has been built and signed and can be downloaded now, what is being
        // worked on. When the release is ahead of the Store — built, attested, waiting for review —
        // that gap is stated rather than left to be worked out from two numbers. Someone curious can
        // take the archive from the Release and try it before Google gets to it.
        var tag = v.tag
          ? '<a href="' + REPO_URL + '/releases/tag/' + encodeURIComponent(v.tag) + '">' + esc(v.tag) + '</a>'
          : '<i>none yet</i>';
        var ahead = newer(verOf(v.tag), v.store) ? ' <i>not on the Store yet</i>' : '';
        bits.push(
          '<div class="vrow">' +
            '<div class="vprod">' + esc(name) + '</div>' +
            '<div class="vfacts">' +
              '<span class="vitem"><b>On the Web Store</b> ' + (v.store ? esc(v.store) : '<i>unknown</i>') + '</span>' +
              '<span class="vitem"><b>Latest release</b> ' + tag + ahead + '</span>' +
              '<span class="vitem"><b>In development</b> ' + (v.repo ? esc(v.repo) : '<i>unknown</i>') + '</span>' +
            '</div>' +
          '</div>');
      });
      if (d.siteUpdated) {
        var f = fmtDate(d.siteUpdated);
        if (f) bits.push('<div class="vrow vsite"><span class="vitem"><b>Site updated</b> ' + esc(f) + '</span></div>');
      }
      box.innerHTML = bits.join('');
      box.classList.add('on');
    })
    .catch(function () { /* the badge simply does not appear */ });

  // The published state is *proven*, never asserted. The markup ships the conservative truth — "in
  // review", no install link — and this promotes it only when /api/versions reports a real version
  // scraped from the listing. So the page is right the moment the Store publishes, without anyone
  // remembering to edit it, and a scrape that fails leaves the understatement standing rather than
  // inventing a link to a listing that serves nothing. Understating is recoverable; the homepage
  // said "on the Web Store" for a day while the listing was empty, and that was found by a reader.
  function publishedState(d) {
    ['crm', 'analytics'].forEach(function (app) {
      var live = !!(d[app] && d[app].store);
      document.querySelectorAll('[data-install="' + app + '"]').forEach(function (el) { el.hidden = !live; });
      document.querySelectorAll('[data-pending="' + app + '"]').forEach(function (el) { el.hidden = live; });
      document.querySelectorAll('[data-store="' + app + '"]').forEach(function (el) {
        if (!live) return;
        el.textContent = 'on the Web Store';
        el.classList.remove('wip'); el.classList.add('live');
      });
    });
  }

  // A tag is `<app>-v1.9.0`; the version is what follows the -v. Compared numerically, because
  // "1.10.0" sorts before "1.9.0" as text and the badge would then claim a release is behind.
  function verOf(tag) { var m = /-v(\d+\.\d+\.\d+)$/.exec(tag || ''); return m ? m[1] : null; }
  function newer(a, b) {
    if (!a) return false;
    if (!b) return true;                       // released, and nothing published to compare against
    var pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (var i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
    return false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
})();
