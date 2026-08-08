/*
 * The site's Worker: the two things it parses out of pages it does not control.
 *
 * Both cases below are failures that reached zoost.it. Nothing here talks to the network — the
 * fetching is not the interesting part, and a test that needs GitHub to be up is a test that fails
 * for reasons that are not about us.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceFn, sliceConst, load, read } from './slice.mjs';
import { readdirSync } from 'node:fs';

// Globbed, never listed: a page added tomorrow is covered without anyone remembering it.
const listPages = () => ['', 'it/'].flatMap((d) =>
  readdirSync(new URL('../site/' + d, import.meta.url))
    .filter((n) => n.endsWith('.html')).map((n) => 'site/' + d + n));

// Sliced rather than imported: _worker.js is an ES module but node reads a bare .js as CommonJS,
// and a package.json at the repo root to change that would be a build-system decision taken by the
// tests. The tests do not get to reshape the project.
const { pickLatestTag, pickStatus, pickSubmissions } = load([
  sliceConst('site/_worker.js', 'IS_VERSION'),
  sliceFn('site/_worker.js', 'pickLatestTag'),
  sliceFn('site/_worker.js', 'pickStatus'),
  sliceFn('site/_worker.js', 'pickSubmissions'),
]);

const entry = (tag, title) =>
  `<entry><title>${title || tag}</title>` +
  `<link rel="alternate" type="text/html" href="https://github.com/ivannot/zoost/releases/tag/${tag}"/></entry>`;

test('a renamed Release does not hide its tag', () => {
  // Reported: the footer said "Released none yet" for crm-v1.9.0, which existed. Its Release had
  // been retitled "Zoost for Zoho CRM 1.9.0", and the parser was reading titles. The href is what
  // says which tag it is, and nobody can rename that.
  const xml = entry('crm-v1.9.0', 'Zoost for Zoho CRM 1.9.0');
  assert.equal(pickLatestTag(xml, 'crm'), 'crm-v1.9.0');
});

test('an annotated tag is found even though its title carries the message', () => {
  // This is the bug. release.sh cuts annotated tags, and GitHub titles those entries
  // `name: first line of the message`. The old filter demanded an exact match on the whole title,
  // so it could only ever match a lightweight tag — every real release would have read as
  // "nothing released yet", which is indistinguishable from a project that has shipped nothing.
  const xml = '<title>Tags from zoost</title>'
    + entry('analytics-v1.0.0', 'analytics-v1.0.0: Zoost for Zoho Analytics 1.0.0 — first submission')
    + entry('v1.0.0');
  assert.equal(pickLatestTag(xml, 'analytics'), 'analytics-v1.0.0');
});

test('a lightweight tag, with no message, is found too', () => {
  assert.equal(pickLatestTag(entry('crm-v2.0.0'), 'crm'), 'crm-v2.0.0');
});

test('the legacy bare tag belongs to no product and is never returned', () => {
  // `v1.0.0` was published as the state of the project for a while: the filter accepted it and
  // rejected every per-product tag, so the site announced the oldest ref in the repository.
  const xml = '<title>Tags from zoost</title>' + entry('v1.0.0');
  assert.equal(pickLatestTag(xml, 'crm'), null);
  assert.equal(pickLatestTag(xml, 'analytics'), null);
});

test('versions sort numerically, not lexically', () => {
  const xml = ['crm-v1.8.1', 'crm-v1.10.0', 'crm-v1.9.0'].map((t) => entry(t)).join('');
  assert.equal(pickLatestTag(xml, 'crm'), 'crm-v1.10.0');   // "1.10.0" < "1.9.0" as strings
});

test('one product never answers with the other product\'s tag', () => {
  const xml = entry('crm-v3.0.0') + entry('analytics-v2.0.0');
  assert.equal(pickLatestTag(xml, 'crm'), 'crm-v3.0.0');
  assert.equal(pickLatestTag(xml, 'analytics'), 'analytics-v2.0.0');
});

test('the Store status is read, and a field that is not a version is dropped', () => {
  // Recorded from a real fetchStatus response, so the shape here cannot drift from the API's.
  const d = {
    publishedItemRevisionStatus: { state: 'PUBLISHED',
      distributionChannels: [{ deployPercentage: 100, crxVersion: '1.9.0' }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW',
      distributionChannels: [{ deployPercentage: 100, crxVersion: '1.38.4' }] },
  };
  const s = pickStatus(d);
  assert.equal(s.published.version, '1.9.0');
  assert.equal(s.published.state, 'PUBLISHED');
  assert.equal(s.submitted.version, '1.38.4');
  assert.equal(s.submitted.state, 'PENDING_REVIEW');
  assert.equal(s.published.deployPercentage, 100);
});

test('a rejected submission is a state, not the absence of one', () => {
  // The whole reason for moving off the scrape. A refused version looks exactly like a queued one
  // from outside, so without this the badge would have claimed "awaiting review" for ever.
  const s = pickStatus({ submittedItemRevisionStatus: { state: 'REJECTED',
    distributionChannels: [{ crxVersion: '2.0.0' }] } });
  assert.equal(s.submitted.state, 'REJECTED');
  assert.equal(s.published, null, 'nothing published is not an error, it is a fact');
});

test('nothing submitted since the last publish is null, not an empty claim', () => {
  const s = pickStatus({ publishedItemRevisionStatus: { state: 'PUBLISHED',
    distributionChannels: [{ crxVersion: '1.0.0' }] } });
  assert.equal(s.submitted, null);
});

test('a version-shaped guard still applies to what Google sends', () => {
  const s = pickStatus({ publishedItemRevisionStatus: { state: 'PUBLISHED',
    distributionChannels: [{ crxVersion: 'rolling' }] } });
  assert.equal(s.published.version, null, 'a value that is not a version is dropped, never shown');
  assert.equal(pickStatus({}), null);
  assert.equal(pickStatus(null), null);
});

// ---------- the gap between what is released and what the Store serves ----------

const { verOf, newer, dev, store, t } = load([
  sliceConst('site/site.js', 'STR'),
  sliceFn('site/site.js', 't'),
  sliceFn('site/site.js', 'verOf'),
  sliceFn('site/site.js', 'newer'),
  sliceFn('site/site.js', 'dev'),
  sliceFn('site/site.js', 'store'),
], { REPO_URL: 'https://github.com/ivannot/zoost', esc: (x) => String(x), LANG: 'en' });

test('a release ahead of the Store is stated, not left to be worked out', () => {
  // The footer showed three numbers and no relationship between them. Someone reading it could not
  // tell that 1.9.0 exists, is signed, is downloadable, and is simply waiting for review.
  assert.equal(newer(verOf('crm-v1.9.0'), '1.0.0'), true);
});

test('once the Store catches up the note disappears', () => {
  assert.equal(newer(verOf('crm-v1.9.0'), '1.9.0'), false);
});

test('a tag with no Store version to compare against counts as ahead', () => {
  // Zoost Analytics: submitted, listing not public, so nothing to compare. The release exists and
  // is downloadable, which is the useful thing to say.
  assert.equal(newer(verOf('analytics-v1.0.0'), null), true);
});

test('no tag is never ahead of anything', () => {
  assert.equal(newer(verOf(null), '1.0.0'), false);
});

test('the comparison is numeric: 1.10.0 is ahead of 1.9.0', () => {
  assert.equal(newer('1.10.0', '1.9.0'), true);
});

test('the badge shows a version number, and links to the tag', () => {
  // Mixed registers: "crm-v1.9.0" sat beside "1.0.0" and read as a different kind of thing, so the
  // reader had to work out that one contained the other. The tag still identifies the release and
  // is still where the link points — it just is not what needs saying.
  assert.equal(verOf('crm-v1.9.0'), '1.9.0');
  assert.equal(verOf('analytics-v1.0.0'), '1.0.0');
});

test('a tag shaped unexpectedly falls back to its own name rather than showing nothing', () => {
  assert.equal(verOf('v1.0.0'), null);   // the caller falls back to the tag itself
});

// ---------- what has actually been submitted, read from RELEASES.md ----------

test('a submitted version is read with its date', () => {
  // "submission pending" would assert something never measured — a tag can exist and never have
  // been sent to Google. The date is in RELEASES.md, so the badge states a fact with a source and
  // the reader can go and check the row.
  const md = [
    '| App | Version | Tag | Commit | SHA-256 | Submitted |',
    '|---|---|---|---|---|---|',
    '| analytics | 1.0.0 | `analytics-v1.0.0` | `b3db394` | *not reproducible* | 2026-08-03 |',
    '| crm | 1.9.0 | `crm-v1.9.0` | `dd94209` | `f34c5ce` | 2026-08-04 |',
  ].join('\n');
  const subs = pickSubmissions(md);
  assert.equal(subs.crm['1.9.0'], '2026-08-04');
  assert.equal(subs.analytics['1.0.0'], '2026-08-03');
});

test('a row whose date is a placeholder is not read as a submission', () => {
  const md = '| crm | 2.0.0 | `crm-v2.0.0` | `abc1234` | `hash` | (date submitted) |';
  // Object.keys rather than deepEqual: the object is created inside the vm context, so its
  // prototype is from another realm and a strict deep comparison fails on that alone.
  assert.equal(Object.keys(pickSubmissions(md)).length, 0);
});

test('prose around the table is not mistaken for rows', () => {
  const md = 'Every version submitted to the Chrome Web Store, with the commit it was built from.';
  assert.equal(Object.keys(pickSubmissions(md)).length, 0);
});

test('a tagged version with no row has not been submitted, and is not claimed to be', () => {
  const subs = pickSubmissions('| crm | 1.9.0 | `crm-v1.9.0` | `dd94209` | `f34c5ce` | 2026-08-04 |');
  assert.equal(subs.crm['1.9.2'], undefined);
});

test('the in-development number links to what is in it, not to where it is stored', () => {
  // A compare against the latest release answers "what would I get beyond the download", which is
  // the question someone clicking that number actually has.
  const html = dev('crm', { repo: '1.9.2', tag: 'crm-v1.9.0' });
  assert.match(html, /\/compare\/crm-v1\.9\.0\.\.\.main/);
  assert.match(html, />1\.9\.2</);
});

test('with no release to compare against it falls back to that app\'s commits', () => {
  const html = dev('analytics', { repo: '1.5.2', tag: null });
  assert.match(html, /\/commits\/main\/apps\/analytics/);
});

test('an unknown version is stated, not linked', () => {
  assert.equal(dev('crm', { repo: null, tag: 'crm-v1.9.0' }), '<i>unknown</i>');
});

test('the Store figure links to the listing when there is one', () => {
  const html = store({ store: '1.0.0', url: 'https://chromewebstore.google.com/detail/abc' });
  assert.match(html, /href="https:\/\/chromewebstore\.google\.com\/detail\/abc"/);
  assert.match(html, />1\.0\.0</);
});

test('an unpublished listing is never linked', () => {
  // A version exists only because the listing was scraped, so "unknown" and "no link" are the same
  // fact. While Zoost Analytics is in review this stays plain text rather than pointing at a page
  // that serves nothing — the homepage already made that mistake once.
  assert.equal(store({ store: null, url: 'https://chromewebstore.google.com/detail/abc' }), '<i>unknown</i>');
});


test('a partial answer is not cached for as long as a complete one', () => {
  // One fetch to raw.githubusercontent failed and both submission dates read "unknown" — for an hour
  // after the source had come back, because the failure was cached with the same TTL as a good
  // answer. Caching exists so a blip is invisible; caching the blip is the opposite.
  const src = read('site/_worker.js');
  assert.match(src, /const TTL_PARTIAL = 60;/, 'the short TTL is gone');
  assert.match(src, /const complete = \[[^\]]+\]\.every\(\(v\) => v != null\);/,
    'nothing decides whether the answer is complete');
  assert.match(src, /const ttl = complete \? TTL : TTL_PARTIAL;/, 'the TTL no longer depends on it');
  assert.match(src, /max-age=\$\{ttl\}/, 'the header still hard-codes one TTL');
});

test('the cache key moves when the caching does', () => {
  // The key ignores the query string on purpose, so a wrong entry cannot be busted from outside. It
  // therefore has to carry a marker, or a change in what gets cached is invisible until expiry.
  assert.match(read('site/_worker.js'), /const CACHE_KEY = '\/api\/versions\?v=15';/);
});


// ---------- what is actually in review ----------
//
// This used to be derived from RELEASES.md - the newest version recorded as submitted - which
// answered by proxy: a row typed after clicking Submit. `fetchStatus` answers directly and carries
// a *state*, so those cases moved up to pickStatus. What stays here is the date, which the API does
// not report: it says which state a revision is in, never when it entered it.

test('the submission date still comes from the ledger, because the API has none', () => {
  const subs = pickSubmissions([
    '| App | Version | Tag | Commit | SHA-256 | Submitted |',
    '|---|---|---|---|---|---|',
    '| crm | 1.38.4 | `crm-v1.38.4` | `6df6603` | `abc` | 2026-08-07 |',
  ].join('\n'));
  assert.equal(subs.crm['1.38.4'], '2026-08-07');
});


test('a malformed row in the ledger is skipped, not read', () => {
  // The guard moved with the code: ranking submissions is Google's job now, but the ledger is still
  // parsed for the date and a row that is not a row must not become one.
  const subs = pickSubmissions([
    '| crm | not-a-version | `t` | `c` | `s` | 2026-01-01 |',
    '| crm | 1.2.3 | `t` | `c` | `s` | not-a-date |',
    '| crm | 1.2.4 | `t` | `c` | `s` | 2026-02-02 |',
  ].join('\n'));
  // Compared key by key: the sliced function builds its object in another realm, so a strict deep
  // comparison fails on the prototype rather than on the content.
  assert.deepEqual(Object.keys(subs.crm), ['1.2.4']);
  assert.equal(subs.crm['1.2.4'], '2026-02-02');
});

test('the footer says what is in review only when it adds a fact', () => {
  const src = read('site/site.js');
  assert.ok(/var repeats = p && p\.state === 'PENDING_REVIEW' && p\.version === verOf\(v\.tag\)/.test(src),
    'the guard that stops it repeating the release line is gone');
  assert.ok(/&& !repeats\)/.test(src), 'the guard is computed but not applied');
  // ...and the guard must stay narrow: the release line can only ever say "awaiting", so a rejected
  // revision on the same version has to survive it. Widening this back to `p.version !== verOf(tag)`
  // would hide the one state a reader has to act on.
  assert.ok(!/p\.version !== verOf\(v\.tag\)\)/.test(src),
    'suppressing every state on the current tag hides REJECTED, which nothing else can say');
  assert.ok(/rejected: '[^']+'/.test(src), 'no label for a refused submission');
  assert.ok(/LBL\[p\.state\]/.test(src), 'an unknown state must not be folded into a known one');
  // The label moved into the string table when the site learnt Italian; what must still exist is the
  // fact being stated, in both languages.
  assert.ok(/review: '[^']+'/.test(src), 'the English label for what is in review is gone');
  // The label is looked up through LBL rather than named directly, because there are three states
  // to say and one of them is a refusal. Asserting `t('review')` would now pass only by reverting.
  assert.ok(/t\(LBL\[p\.state\]\)/.test(src), 'the footer no longer states which state it is in');
});

// ---------- The footer badge speaks the page's language, all of it ----------

test('everything the badge writes goes through the string table', () => {
  // The Italian home showed «sul Chrome Web Store» on one card and «on the Web Store» on the other,
  // live: every other string in the badge was in the table, and the one written inline was the one
  // that stayed English. The offending label is gone with the promotion it belonged to (see below),
  // but the rule it proved covers everything else the badge writes after the page loads.
  const src = read('site/site.js');
  for (const lang of ['en', 'it']) {
    const table = src.slice(src.indexOf(`    ${lang}: {`), src.indexOf('},', src.indexOf(`    ${lang}: {`)));
    for (const key of ['store', 'release', 'dev', 'review', 'updated', 'none', 'unknown']) {
      assert.ok(table.includes(key + ':'), `${lang} has no ${key}`);
    }
  }
});

// ---------- A fact stated only at runtime is a fact half the readers never get ----------

test('no page leaves a product\'s store presence to be filled in by script', () => {
  // site.js used to hide the "submitted, in review" wording the moment /api/versions reported a real
  // scraped version, so the markup could ship the conservative state and be promoted in the browser.
  // It worked, and it was still wrong: the reader this site is built for - an assistant handed the
  // URL and asked to assess the product - does not run scripts. It read five surfaces saying Zoost
  // Analytics was in review and three saying it was on the Store, and reported the contradiction.
  //
  // So the markup states what is true and auditcheck holds it against /api/versions. This is the
  // guard against the mechanism coming back: it is a fair-looking idea, and it is the wrong shape
  // for a fact somebody has to be able to read without executing anything.
  const js = read('site/site.js');
  assert.ok(!/data-(pending|install|store)/.test(js), 'site.js promotes a published state again');
  for (const f of listPages()) {
    assert.ok(!/data-(pending|install|store)=/.test(read(f)),
      `${f}: states a product's store presence only to script`);
  }
});

test('nothing in the footer badge is unbreakable on a phone', () => {
  // «Ultima release 1.8.0 inviata il 5 ago 2026, in attesa di revisione» was 457px of nowrap text in
  // a 331px column: the footer scrolled sideways while every other block fitted. The English wording
  // is shorter and got away with it — the usual way a translation finds a layout bug. And mobile
  // browsers inflate text inside an overflowing block, which is why that one line also looked bigger
  // than its neighbours on a phone and identical to them on a desktop.
  const css = read('site/site.css');
  assert.match(css, /@media \(max-width:640px\)\{#vers \.vitem\{white-space:normal\}\}/);
  assert.match(css, /text-size-adjust:100%/);
});
