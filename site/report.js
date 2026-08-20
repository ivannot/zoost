/* The report page's own script.
 *
 * The panel puts the report straight into the box below - through the DOM, never through the
 * address. It used to arrive in `location.hash`, on the reasoning that a fragment is never sent to a
 * server: true, and not the whole question, because the navigation itself is recorded in the
 * browser's history and syncs with it. Nothing about the report is in this page's URL now.
 *
 * This page loads one third-party script, Cloudflare's Turnstile, which is what stands between the
 * endpoint and a script posting to the maintainer's issue tracker all day. Nothing else here phones
 * anywhere: no analytics, no beacon, no autosave, and the report is never stored.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // Both are shown: the form, which the panel is about to fill, and the note for somebody who
  // arrived here by hand - who can paste into the same box. Nothing is hidden waiting for an
  // arrival that may never come, because a page that looks broken until an extension writes to it
  // is a page that looks broken.
  $('form').style.display = '';
  $('none').style.display = '';

  var original = '';
  var body = $('body');
  // What the panel wrote is the baseline. Whatever the reader does to it afterwards is measured
  // against this, and reported - a trimmed trace is still welcome, but it is no longer evidence.
  body.addEventListener('input', function () {
    if (!original) { original = body.value; return; }
    markEdited();
  });

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
    var text = body.value.trim();
    if (!text) { msg.textContent = 'There is nothing left to send.'; return; }
    if (!/^Zoost /.test(text)) {
      msg.textContent = 'The first line has to stay as the panel wrote it - it is what identifies this as a Zoost report.';
      return;
    }
    var field = document.querySelector('[name="cf-turnstile-response"]');
    if (!field) {
      // Said rather than hinted: without the widget there is no path forward from this page, and
      // «complete the check above» over a check that never rendered is a dead end with no reason.
      msg.textContent = 'The anti-abuse check could not load, so this page cannot send anything. Please paste the text into an issue at github.com/ivannot/zoost/issues, or email it to ivan@zoost.it.';
      return;
    }
    var token = field.value || '';
    if (!token) { msg.textContent = 'Please complete the check above first.'; return; }
    $('send').disabled = true;
    msg.textContent = 'Sending…';
    fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report: text, says: $('says').value.slice(0, 2000), token: token,
        edited: original !== '' && text !== original.trim() }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (res.ok && res.j && res.j.url) {
        // The link is the receipt: the reader can see exactly what was published, and delete
        // nothing - which is why they were asked to read it here rather than after the fact.
        msg.innerHTML = 'Sent. It is now <a href="' + encodeURI(res.j.url) + '">this issue</a>. Thank you.';
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
