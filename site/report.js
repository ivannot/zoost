/* The report page's own script.
 *
 * The panel puts the report straight into the box below - through the DOM, never through the
 * address. It used to arrive in `location.hash`, on the reasoning that a fragment is never sent to a
 * server: true, and not the whole question, because the navigation itself is recorded in the
 * browser's history and syncs with it. Nothing about the report is in this page's URL now.
 *
 * Which of the two readers arrived is therefore **not knowable at load**: the panel writes after the
 * page is complete, and a bookmark writes nothing ever. So the page does not try to know. It opens in
 * the state that needs no arrival - somebody describing a problem in their own words - and moves to
 * the trace the moment text lands in the box. An empty locked textarea under «this is what will be
 * sent» is what it used to show a reader who came from a link, and that reads as broken software.
 *
 * This page loads one third-party script, Cloudflare's Turnstile, which is what stands between the
 * endpoint and a script posting to the maintainer's issue tracker all day. Nothing else here phones
 * anywhere: no analytics, no beacon, no autosave, and the report is never stored.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };


  // What a hand-written report puts where the trace would be. The endpoint requires a report to
  // begin with «Zoost », so this both satisfies that and says, in the issue, what is missing.
  var HAND = 'Zoost report written by hand on zoost.it - no panel, no trace.';

  var original = '';
  var body = $('body');
  var hand = true;

  // The arrival, and the only signal there is: the panel sets the value and dispatches `input`.
  // A reader typing into the box cannot reach this - in the hand state the box is not on the page.
  body.addEventListener('input', function () {
    if (!original) { original = body.value; toTrace(); return; }
    markEdited();
  });

  function toTrace() {
    hand = false;
    // The header's language link is a navigation, and a navigation loses the report - the panel
    // wrote it into *this* document and there is nowhere else it exists. Losing it silently is the
    // worst of the three options; the panel already opened the page in the browser's own language,
    // so the link has nothing left to offer a reader who is holding a trace.
    var lang = document.querySelector('a.ncta[hreflang]');
    if (lang) lang.style.display = 'none';
    $('trace').style.display = '';
    $('subpanel').style.display = '';
    $('addpanel').style.display = '';
    $('addheadpanel').style.display = '';
    $('subhand').style.display = 'none';
    $('addhand').style.display = 'none';
    $('addhead').style.display = 'none';
  }

  function markEdited() {
    var changed = body.value !== original;
    $('editedNote').style.display = changed ? '' : 'none';
  }

  $('edit').onclick = function () {
    body.readOnly = false;
    body.focus();
    $('edit').style.display = 'none';
  };

  $('send').onclick = function () {
    var msg = $('msg');
    var says = $('says').value.slice(0, 2000);
    var text = hand ? HAND : body.value.trim();
    if (hand) {
      if (!says.trim()) { msg.textContent = 'Please describe the problem first - that is the whole of what would be sent.'; return; }
    } else {
      if (!text) { msg.textContent = 'There is nothing left to send.'; return; }
      if (!/^Zoost /.test(text)) {
        msg.textContent = 'The first line has to stay as the panel wrote it - it is what identifies this as a Zoost report.';
        return;
      }
    }
    var field = document.querySelector('[name="cf-turnstile-response"]');
    if (!field) {
      // Said rather than hinted: without the widget there is no path forward from this page, and
      // «complete the check above» over a check that never rendered is a dead end with no reason.
      msg.textContent = 'The anti-abuse check could not load, so this page cannot send anything. Please paste the text into an issue at github.com/ivannot/zoost/issues, or email it to ivan@zoost.it.';
      return;
    }
    var token = field.value || '';
    // The widget is `interaction-only`, so in the ordinary case there is nothing on screen to
    // point at: «complete the check above» would name something the reader cannot see. Either
    // it is still running, or it has just drawn itself and is waiting - the sentence covers both.
    if (!token) { msg.textContent = 'The anti-abuse check has not finished. If a box has appeared above, complete it; otherwise press Send again in a moment.'; return; }
    $('send').disabled = true;
    msg.textContent = 'Sending\u2026';
    fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report: text, says: says, token: token, hand: hand,
        edited: !hand && original !== '' && text !== original.trim() }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (res.ok && res.j && res.j.url) {
        // The link is the receipt: the reader can see exactly what was published, and delete
        // nothing - which is why they were asked to read it here rather than after the fact.
        // The link is the only handle they will ever have: nothing here knows who sent this, so
        // there is no notification to receive and no account to see a reply under. Said plainly,
        // because a reader who assumes otherwise waits for an answer that cannot arrive.
        msg.innerHTML = 'Sent. It is now <a href="' + encodeURI(res.j.url) + '">this issue</a>. Keep that '
          + 'link: nothing here knows who you are, so there is no notification to come and no account to '
          + 'see a reply under - opening it again is the only way back to what was said.';
        $('send').style.display = 'none';
        return;
      }
      $('send').disabled = false;
      msg.textContent = (res.j && res.j.error)
        ? res.j.error
        : 'It could not be sent. You can paste the text into an issue yourself, or email it.';
      if (window.turnstile) window.turnstile.reset();
    }).catch(function () {
      $('send').disabled = false;
      msg.textContent = 'It could not be sent - the network refused. You can paste the text into an issue yourself, or email it.';
      if (window.turnstile) window.turnstile.reset();
    });
  };
})();
