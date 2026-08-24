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

  // Named, and passed by reference. A callback written in place is a scope
  // `tools/asynccheck.py` cannot enter, and a check that cannot enter a scope says nothing about
  // what happens in it - which is the difference between «there is nothing there» and «nobody
  // looked». The chains below are unchanged; only their continuations have names.
  function jsonOrNull(r) { return r.ok ? r.json() : null; }
  function showVersions(d) {
  // Thrown rather than returned, so the one place that words a failure is the one below. This
  // read `return`, and the badge then simply did not appear: a reader cannot tell a page that
  // carries no version block from one whose numbers could not be read, and the site's own rule
  // is that a missing number is said and never left blank. Both siblings already did it - the
  // /emergency box throws on the same line, and the report form words its own refusal - so this
  // was one of three, in the same file as one of the other two.
  if (!d) throw new Error('no answer');
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
          '<span class="vitem"><b>' + t('store') + '</b> ' + store(v, d.storeAsOf) + '</span>' +
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
  }
  function showAhead(d) {
    if (!d) throw new Error('no answer');
    renderAhead(d);
  }

  // One request feeds two independent things: the footer badge and the guide's "covers" stamp.
  // Either may be absent on a given page, so neither is allowed to be the other's precondition.
  var REPO_URL = 'https://github.com/ivannot/zoost';
  var box = document.getElementById('vers');
  var stamp = document.querySelector('.upd .dv, .upd .dd');
  // `#ahead` is /emergency's block, and it is listed here so that page does not depend on also
  // carrying a footer badge. Three independent things, one guard, none of them a precondition for
  // the others - which is the same rule the two above already follow.
  var aheadBox = document.getElementById('ahead');
  if ((!box && !stamp && !aheadBox) || !window.fetch) return;

  function fmtDate(iso, longMonth) {
    var d = new Date(iso);
    if (isNaN(d)) return null;
    // The locale follows <html lang>, not the browser's: the page it lands in is Italian or English,
    // and a date reading "3 August 2026" inside an Italian sentence is the same defect as an
    // untranslated label. en-GB stays the fallback so nothing changes on the English pages.
    return d.toLocaleDateString(LANG === 'it' ? 'it-IT' : 'en-GB',
                                { day: 'numeric', month: longMonth ? 'long' : 'short', year: 'numeric' });
  }

  // How long a reading may sit before the page says so. The workflow runs every half hour, so a day
  // is forty-eight missed runs: an order of magnitude above the jitter GitHub's scheduled runs show
  // under load, which is what rules out a threshold in hours, and well below the point where somebody
  // would act on a number nobody has checked since yesterday.
  const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

  // Deliberately not a judgement on the reading, which is true whatever its age - only on whether
  // anything has looked lately. An unparseable date returns false: it is a different fault and it
  // already shows up as a missing line, and reporting it as staleness would name the wrong problem,
  // which this project treats as worse than silence.
  function staleReading(iso, nowMs) {
    const asked = Date.parse(iso);
    if (isNaN(asked)) return false;
    // A browser clock set behind ours yields a negative age, which is not stale.
    return (nowMs - asked) > STALE_AFTER_MS;
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
      // /emergency only. Kept in the same table as the rest because a second one would be a second
      // place to forget a language in.
      inStep: 'and that is the newest release. Nothing to do here.',
      ahead1: 'one release ahead of the Store', aheadN: 'releases ahead of the Store',
      cantAsk: 'The Store could not be asked just now, so this page cannot say whether anything is ahead of it.',
      releasesPage: 'The releases page has the answer',
      versFailed: 'The version numbers could not be read just now.',
      released: 'Released', download: 'Download', hashes: 'notes and hash',
      noNotes: 'No notes were published for this version.',
      notesUnread: 'The notes for this version could not be fetched. They are on the release page.',
      queued: 'submitted, awaiting review', refused: 'this submission was rejected',
      askFailed: 'This check could not be run just now.',
      storeAsOf: 'The Store was last asked',
      storeStale: 'This reading is older than usual - the check that asks Google runs every half hour.',
    },
    it: {
      store: 'Sul Chrome Web Store', release: 'Ultima release', dev: 'In sviluppo',
      review: 'In revisione', updated: 'Sito aggiornato',
      rejected: 'Rifiutata', staged: 'Approvata, non ancora pubblicata',
      awaiting: 'in attesa di revisione', notSubmitted: 'non ancora inviata',
      none: 'nessuna', unknown: 'sconosciuta',
      inStep: "ed è l'ultima release. Qui non c'è niente da fare.",
      ahead1: 'una release avanti rispetto allo Store', aheadN: 'release avanti rispetto allo Store',
      cantAsk: 'Non è stato possibile interrogare lo Store, quindi questa pagina non può dire se ci sia qualcosa avanti.',
      releasesPage: 'La pagina delle release ha la risposta',
      versFailed: 'Non e stato possibile leggere i numeri di versione adesso.',
      released: 'Rilasciata', download: 'Scarica', hashes: 'note e hash',
      noNotes: 'Per questa versione non sono state pubblicate note.',
      notesUnread: 'Non e stato possibile recuperare le note di questa versione. Sono nella pagina della release.',
      queued: 'inviata, in attesa di revisione', refused: 'questo invio è stato rifiutato',
      askFailed: 'Non è stato possibile eseguire questo controllo adesso.',
      storeAsOf: 'Lo Store è stato interrogato l\'ultima volta il',
      storeStale: 'Questa lettura è più vecchia del solito - il controllo che interroga Google gira ogni mezz\'ora.',
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
    .then(jsonOrNull)
    .then(showVersions)
    .catch(function () {
      // One quiet line, not a broken layout: the numbers are chrome on most pages, and what is
      // being refused here is the *silence*, not the modesty. It points where the answer actually
      // is, which is what every other empty state in this project does.
      if (!box) return;
      box.innerHTML = '<div class="vrow"><span class="vitem">' + esc(t('versFailed')) +
                      ' <a href="' + REPO_URL + '/releases">' + esc(t('releasesPage')) + '</a>.</span></div>';
      box.classList.add('on');
    });


  // Linked only when there is a version, which is the same thing as the listing serving content:
  // the number comes from scraping that page. So the link cannot lead somewhere empty - while
  // Zoost Analytics is in review the figure reads "unknown" and stays plain text.
  function store(v, asOf) {
    if (!v.store) return '<i>' + t('unknown') + '</i>';
    var n = v.url ? '<a href="' + v.url + '">' + esc(v.store) + '</a>' : esc(v.store);
    // A number nobody has checked lately is marked as such. `staleReading` was written for this and
    // was consulted in one place - the ahead box on /emergency - while the badge that carries the
    // same reading onto **every page** stated it as a live fact. If the scheduled run that refreshes
    // it stops - a revoked key, a disabled schedule, a quota - KV keeps the last good answer, `cws`
    // stays `ok`, and «On the Web Store 1.46.0» would go on being true-looking indefinitely.
    //
    // Marked rather than hidden: the reading is not wrong, it is old, and this site's rule is to
    // hand over the fact and let the reader decide. The title carries the sentence /emergency
    // already uses, so the two say the same thing about the same number.
    if (asOf && staleReading(asOf, Date.now())) {
      n += ' <span class="stale" title="' + esc(t('storeStale')) + '">*</span>';
    }
    return n;
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

  /* /emergency: what has been released but is not on the Store yet, and what changed in it.
   *
   * The page is a set of instructions for a situation that is usually not happening, so the first
   * thing it does is say whether it is. Three answers, kept apart on purpose: in step, something
   * ahead, and «nobody could ask». The third is never rendered as either of the other two - a page
   * that says "you are up to date" when it does not know would send somebody back to a broken
   * extension believing they had checked, and that is the one wrong answer with a cost.
   *
   * So «could not ask» covers two sources, not one: the Store not answering, and the tag feed not
   * answering. With no tag list, "nothing is ahead" is not a finding, it is the absence of one.
   *
   * Nothing here nudges. It prints the two numbers, the changelog and a link. Whether what changed
   * is worth running an unpacked extension for is the reader's call, and it is the one judgement
   * this page is in no position to make for them.
   */
  function mdToHtml(src) {
    // Escaped first, then a small subset put back. The notes are ours, but they arrive over a
    // network and "we wrote it" is not a security model. Bold and code are what the files use.
    return String(src).split(/\n{2,}/).map(function (para) {
      var h = esc(para.replace(/\s*\n\s*/g, ' ')).trim();
      if (!h) return '';
      h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
      return '<p>' + h + '</p>';
    }).join('');
  }

  function renderAhead(d) {
    aheadBox.innerHTML = [['crm', 'Zoost CRM'], ['analytics', 'Zoost Analytics']].map(function (pr) {
      var app = pr[0], v = d && d[app];
      if (!v) return '';
      var head = '<h3>' + esc(pr[1]) + '</h3>';
      // No Store figure, or no tag feed: either way the comparison could not be made.
      if (!v.store || !v.latest) {
        return '<div class="box">' + head + '<p>' + esc(t('cantAsk')) + ' <a href="' + REPO_URL +
               '/releases">' + esc(t('releasesPage')) + '</a>.</p></div>';
      }
      var list = v.ahead || [];
      if (!list.length) {
        return '<div class="box">' + head + '<p><b>' + esc(t('store')) + ': ' + esc(v.store) +
               '</b> - ' + esc(t('inStep')) + '</p></div>';
      }
      var out = ['<div class="box warn">' + head + '<p><b>' + esc(t('store')) + ': ' +
                 esc(v.store) + ' · ' + esc(t('released')) + ': ' + esc(list[0].version) + '</b> - ' +
                 esc(list.length === 1 ? t('ahead1') : list.length + ' ' + t('aheadN')) + '</p>'];
      list.forEach(function (a) {
        // What Google says about *this* version, and only about this one. A submission sitting in
        // the queue is the reason the page exists; a refused one is worth knowing before you install
        // it, because it is not going to arrive on its own.
        var p = v.pending && v.pending.version === a.version ? v.pending.state : null;
        var state = p === 'PENDING_REVIEW' ? t('queued') : p === 'REJECTED' ? t('refused') : '';
        out.push('<p><b>' + esc(a.version) + '</b>' + (state ? ' - ' + esc(state) : '') + '<br>' +
                 '<a href="' + esc(a.zip) + '">' + esc(t('download')) + ' zoost-' + esc(app) + '-' +
                 esc(a.version) + '-store.zip</a> · <a href="' + REPO_URL + '/releases/tag/' +
                 esc(a.tag) + '">' + esc(t('hashes')) + '</a></p>');
        out.push('<div class="note">' +
                 // Three answers, not two. «There are none» is a fact about the version; «could
                 // not be fetched» is a fact about this request, and stating the first over the
                 // second argues against installing a version for a reason that is not true.
                 (a.notes ? mdToHtml(a.notes)
                   : '<p>' + esc(t(a.notesWhy === 'unreadable' ? 'notesUnread' : 'noNotes')) + '</p>') +
                 '</div>');
      });
      return out.join('') + '</div>';
    }).join('');
    // When the Store was last actually asked. The number itself is printed rather than judged - it is
    // a true reading whatever its age - but how *tired* it is does get said, which is a different
    // thing and the only signal a workflow that stopped ever produces. It writes to KV on every run,
    // so a date that stopped advancing means the run stopped, unambiguously; while the reading was a
    // committed file it moved only when the Store did, and a threshold then would have called a quiet
    // fortnight a failure.
    //
    // The sentence hands over the yardstick («runs every half hour») instead of a verdict, and it
    // deliberately does not draw the conclusion that the versions below may have moved: a reader who
    // has just been given the interval and a date two days old draws it unaided, and this page's whole
    // posture is that the decision to install by hand is theirs.
    if (d && d.storeAsOf) {
      const when = fmtDate(d.storeAsOf, true);
      if (when) {
        let line = esc(t('storeAsOf')) + ' ' + esc(when) + '.';
        if (staleReading(d.storeAsOf, Date.now())) line += ' ' + esc(t('storeStale'));
        aheadBox.innerHTML += '<p class="meta">' + line + '</p>';
      }
    }
  }

  if (aheadBox) {
    fetch('/api/ahead', { headers: { accept: 'application/json' } })
      .then(jsonOrNull)
      .then(showAhead)
      .catch(function () {
        // The instructions on the page stay readable either way; this only stops the block claiming
        // to have checked something it did not, and points at where the answer actually is.
        aheadBox.innerHTML = '<p class="meta">' + esc(t('askFailed')) + ' <a href="' + REPO_URL +
                             '/releases">' + esc(t('releasesPage')) + '</a>.</p>';
      });
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
  // The same comparison the Worker makes, and it was not. This looped `i < 3` and read a missing
  // component as `undefined`, where `undefined > n` is false - so `1.9.1` was **not** newer than
  // `1.9`. The Worker's `cmpVer` reads a missing component as 0 and walks to the longer of the two.
  //
  // Reachable rather than theoretical: `b` is the version Google reports, and `IS_VERSION` in both
  // `_worker.js` and `tools/storestatus.py` deliberately accepts **two to four** components, because
  // this repository already knows Google can answer with something other than three. On the day it
  // does, the badge goes quiet about a release that is genuinely ahead - «unknown, never wrong»
  // broken in the direction of saying nothing, which is the harder one to notice.
  //
  // `tests/worker.test.mjs` runs both against the same inputs, so they cannot drift apart again.
  function newer(a, b) {
    if (!a) return false;
    if (!b) return true;                       // released, and nothing published to compare against
    var pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
})();
