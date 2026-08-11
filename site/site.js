/*
 * site.js - progressive enhancement for zoost.it. The pages are complete without it: this only
 * fills in things that cannot be known when the HTML is written. If it does not run, or the API is
 * unreachable, nothing breaks and nothing misleading is left on screen.
 */
(function () {
  'use strict';

  // Copyright year. A notice reads as the year of publication, so the first year stays fixed and a
  // range appears only once the current year is actually later - "Copyright 2027" alone on work
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
    // The locale follows <html lang>, not the browser's: the page it lands in is Italian or English,
    // and a date reading "3 August 2026" inside an Italian sentence is the same defect as an
    // untranslated label. en-GB stays the fallback so nothing changes on the English pages.
    return d.toLocaleDateString(LANG === 'it' ? 'it-IT' : 'en-GB',
                                { day: 'numeric', month: longMonth ? 'long' : 'short', year: 'numeric' });
  }

  // The version badge is the one thing on the page written by script, so it is the one thing a
  // translated page cannot translate by itself. The language comes from <html lang>, which every page
  // already declares; anything not listed falls back to English rather than showing a key.
  var LANG = (document.documentElement.lang || 'en').slice(0, 2);
  var STR = {
    en: {
      store: 'On the Web Store', release: 'Latest release', dev: 'In development',
      review: 'Awaiting review', updated: 'Site updated',
      rejected: 'Rejected', staged: 'Approved, not yet published',
      awaiting: 'awaiting review', notSubmitted: 'not submitted yet',
      none: 'none yet', unknown: 'unknown',
    },
    it: {
      store: 'Sul Chrome Web Store', release: 'Ultima release', dev: 'In sviluppo',
      review: 'In revisione', updated: 'Sito aggiornato',
      rejected: 'Rifiutata', staged: 'Approvata, non ancora pubblicata',
      awaiting: 'in attesa di revisione', notSubmitted: 'non ancora inviata',
      none: 'nessuna', unknown: 'sconosciuta',
    },
  };
  function t(k) { return (STR[LANG] || STR.en)[k] || STR.en[k]; }

  // "Covers Zoost X · updated Y" on the guide. Kept in step with the repo automatically: the rule is
  // that documentation ships with the code that changed it, so the version the docs describe is the
  // version in the manifest. The date is the last change to that guide specifically - using the whole
  // site would claim the guide was updated when only the homepage moved.
  // "Covers Zoost X · updated Y" on a guide. Which product's version, and which file's date, come
  // from the .upd element itself - a guide that borrowed the other product's number would be stating
  // something false about the thing it documents.
  function fillDocsStamp(d) {
    var el = document.querySelector('.upd');
    if (!el) return;
    var app = el.getAttribute('data-app') || 'crm';
    var v = el.querySelector('.dv');
    var t = el.querySelector('.dd');
    var ver = (d[app] && d[app].repo) || (app === 'crm' ? d.repo : null);
    // What the guide documents is the version in the repository - documentation ships with the code
    // that changed it. But between a submission and its publication the Store is serving something
    // older (three or four days for Zoho CRM, longer here), and a reader installing today would be
    // reading about features their copy does not have. So when the two differ, the line says both.
    var store = d[app] && d[app].store;
    if (v && ver) v.textContent = (store && store !== ver) ? ver + ' (the Store is serving ' + store + ')' : ver;
    var when = el.getAttribute('data-updated-key') === 'analytics' ? d.docsAnalyticsUpdated : d.docsUpdated;
    if (t && when) { var f = fmtDate(when, true); if (f) t.textContent = f; }
  }

  fetch('/api/versions', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      fillDocsStamp(d);
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
      // Zoho CRM you can install is 1.0.0" - it reads as a statement about Zoho's product, and it
      // is false: 1.0.0 is our version. A label that attributes a property has to name the thing
      // the property belongs to. (A label that merely *selects* a platform - the nav buttons, the
      // guide switcher - may say "Zoho CRM", because there you are choosing a platform.)
      var prods = [
        ['crm', 'Zoost CRM', d.crm || { store: d.store, repo: d.repo, tag: d.tag }],
        ['analytics', 'Zoost Analytics', d.analytics],
      ];
      prods.forEach(function (pr) {
        var app = pr[0], name = pr[1], v = pr[2];
        if (!v || (!v.store && !v.repo)) return;
        // "none yet" rather than "unknown": for a product with no tag those are opposite claims -
        // one says we failed to look, the other is a fact, and it is the fact RELEASES.md states.
        //
        // The tag is a link to its Release, where the archive, its SHA-256 and the two verification
        // commands are. Not to the .zip: a footer that starts a download when clicked is a surprise,
        // and the number beside the file is the point rather than the file. This is the one place
        // the badge stops being a claim and becomes something the reader can check.
        // Three answers to three different questions, in the order a version travels: what you can
        // install today, what has been built and signed and can be downloaded now, what is being
        // worked on. When the release is ahead of the Store - built, attested, waiting for review -
        // that gap is stated rather than left to be worked out from two numbers. Someone curious can
        // take the archive from the Release and try it before Google gets to it.
        // The number, not the tag name. Every other figure in this badge is a version, and
        // "crm-v1.9.0" beside "1.0.0" reads as two different kinds of thing - the reader has to
        // work out that one of them contains the other. The tag is still where the link goes,
        // because that is what identifies the release; it just is not what needs saying.
        var rel = verOf(v.tag) || v.tag;
        var tag = v.tag
          ? '<a href="' + REPO_URL + '/releases/tag/' + encodeURIComponent(v.tag) + '">' + esc(rel) + '</a>'
          : '<i>' + t('none') + '</i>';
        // Said only when it is known. "Submitted on 4 Aug - awaiting review" is a fact with a
        // source: RELEASES.md records the date, and the reader can go and check the row. A tag that
        // is ahead of the Store but has no such row has *not* been submitted as far as anyone can
        // tell, and saying "submission pending" there would be asserting something we never
        // measured - the same shape as every claim this project has had to walk back.
        var p = v.pending;
        var state = releaseState(v, d.cws === 'ok');
        var ahead = state === 'quiet' ? '' : ' <i>' + t(state) + '</i>';
        // What is actually in review, when that is not the newest tag. Without this the page said
        // "latest release 1.11.0 not submitted yet" and gave no sign that 1.9.0 was in review - every
        // word true, the reader misled. Shown only when it adds a fact: newer than the Store, and
        // not already the release line above.
        // The state comes from the Chrome Web Store itself now, not from a row we typed after
        // clicking Submit. That is what makes REJECTED sayable: from outside, a refused submission
        // and a queued one look identical, so the badge used to promise "awaiting review" about a
        // version Google had already turned down, indefinitely. An unknown state is not rendered
        // rather than being folded into the nearest one we recognise.
        var review = '';
        var LBL = { PENDING_REVIEW: 'review', REJECTED: 'rejected', STAGED: 'staged' };
        // Said only when it adds a fact. The release line above already reads "1.38.4, submitted 7
        // Aug, awaiting review" when the newest tag is the one in the queue, and repeating it is how
        // this line stopped being read. But that line can only ever express *awaiting* - so a
        // rejected or approved-not-yet-published revision is new information even on the same
        // version, and suppressing it there would hide the only state anyone needs to act on.
        var repeats = p && p.state === 'PENDING_REVIEW' && p.version === verOf(v.tag);
        if (p && p.version && LBL[p.state] && newer(p.version, v.store) && !repeats) {
          review = '<span class="vitem"><b>' + t(LBL[p.state]) + '</b> ' + esc(p.version) + '</span>';
        }
        bits.push(
          '<div class="vrow">' +
            '<div class="vprod">' + esc(name) + '</div>' +
            '<div class="vfacts">' +
              '<span class="vitem"><b>' + t('store') + '</b> ' + store(v) + '</span>' +
              review +
              '<span class="vitem"><b>' + t('release') + '</b> ' + tag + ahead + '</span>' +
              '<span class="vitem"><b>' + t('dev') + '</b> ' + dev(app, v) + '</span>' +
            '</div>' +
          '</div>');
      });
      if (d.siteUpdated) {
        var f = fmtDate(d.siteUpdated);
        if (f) bits.push('<div class="vrow vsite"><span class="vitem"><b>' + t('updated') + '</b> ' + esc(f) + '</span></div>');
      }
      box.innerHTML = bits.join('');
      box.classList.add('on');
    })
    .catch(function () { /* the badge simply does not appear */ });


  // Linked only when there is a version, which is the same thing as the listing serving content:
  // the number comes from scraping that page. So the link cannot lead somewhere empty - while
  // Zoost Analytics is in review the figure reads "unknown" and stays plain text.
  function store(v) {
    if (!v.store) return '<i>' + t('unknown') + '</i>';
    return v.url ? '<a href="' + v.url + '">' + esc(v.store) + '</a>' : esc(v.store);
  }

  // The in-development number links to what is *in* it. A compare view against the latest release
  // answers the question someone actually has - "what would I get that the download does not have"
  // - rather than merely showing where the number is stored. Without a release to compare against
  // there is nothing to diff, so it falls back to that app's commits, which is the same question
  // asked the only way still available.
  function dev(app, v) {
    if (!v.repo) return '<i>' + t('unknown') + '</i>';
    var href = v.tag
      ? REPO_URL + '/compare/' + encodeURIComponent(v.tag) + '...main'
      : REPO_URL + '/commits/main/apps/' + app;
    return '<a href="' + href + '">' + esc(v.repo) + '</a>';
  }

  // A tag is `<app>-v1.9.0`; the version is what follows the -v. Compared numerically, because
  // "1.10.0" sorts before "1.9.0" as text and the badge would then claim a release is behind.
  /** What the release line may say about a tag that is ahead of the Store. One source: Google.
   *
   *  It used to read `submitted` out of RELEASES.md as well, and that is what made it lie: with
   *  1.39.0 sitting in the review queue - which the API said in as many words - the page announced
   *  «not submitted yet», because nobody had typed the row yet. A hand-kept copy of a fact the
   *  platform already reports can only ever fall behind it.
   *
   *  So the ledger is out of this entirely, and the date with it - how long a package has been in
   *  the queue is not worth knowing, «submitted» is. What that costs is a state that has to be
   *  admitted rather than guessed: with no answer from the Store API, «nothing is in review» and
   *  «nobody could ask» look identical, and calling that «not submitted yet» would be inventing a
   *  measurement. It says nothing at all instead.
   *
   *  'quiet' is a real answer and not a shrug: a rejected or approved-not-yet-published revision is
   *  stated by the line above, and «awaiting review» beside it would be the badge contradicting
   *  itself - which is the same defect one state over. */
  function releaseState(v, asked) {
    var tag = verOf(v.tag);
    if (!newer(tag, v.store)) return 'quiet';
    var p = v.pending;
    var mine = p && p.version === tag ? p.state : null;    // what Google says about *this* version
    if (mine) return mine === 'PENDING_REVIEW' ? 'awaiting' : 'quiet';
    if (!asked) return 'quiet';                            // the Store API could not be reached
    if (p && p.version && newer(p.version, v.store)) return 'quiet';   // something else is in the queue
    return 'notSubmitted';
  }
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
