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

  // Version alignment badge. Every field is optional: whatever is unknown says so rather than
  // showing a stale or invented number.
  var box = document.getElementById('vers');
  if (!box || !window.fetch) return;

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  fetch('/api/versions', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var bits = [];
      bits.push('<span class="vitem"><b>Web Store</b> ' + (d.store ? esc(d.store) : '<i>unknown</i>') + '</span>');
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
