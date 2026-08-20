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
import { readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

// Globbed, never listed: a page added tomorrow is covered without anyone remembering it.
const listPages = () => ['', 'it/'].flatMap((d) =>
  readdirSync(new URL('../site/' + d, import.meta.url))
    .filter((n) => n.endsWith('.html')).map((n) => 'site/' + d + n));

// Sliced rather than imported: _worker.js is an ES module but node reads a bare .js as CommonJS,
// and a package.json at the repo root to change that would be a build-system decision taken by the
// tests. The tests do not get to reshape the project.
// `cmpVer` and `isNewer` are carried along because the functions below call them. They were not, the
// first time, and the failure landed on an unrelated case - `pickLatestTag` sorting with an
// undefined comparator - which is the free-variable trap this repository has already recorded once.
const { pickLatestTag, tagsAhead } = load([
  sliceConst('site/_worker.js', 'IS_VERSION'),
  sliceFn('site/_worker.js', 'cmpVer'),
  sliceConst('site/_worker.js', 'isNewer'),
  sliceFn('site/_worker.js', 'pickLatestTag'),
  sliceFn('site/_worker.js', 'tagsAhead'),
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

/* What /emergency offers, which is a different question from "what is the newest tag": it is
 * measured against what the Store is serving, and the direction of a wrong answer matters. */

const feed = ['crm-v1.40.0', 'crm-v1.39.0', 'crm-v1.38.4', 'analytics-v1.23.0', 'v1.0.0']
  .map((t) => entry(t)).join('');

test('what is ahead of the Store is listed, newest first', () => {
  assert.equal(tagsAhead(feed, 'crm', '1.38.4').map((t) => t.version).join(' '), '1.40.0 1.39.0');
});

test('nothing is ahead once the Store has caught up', () => {
  assert.equal(tagsAhead(feed, 'crm', '1.40.0').length, 0);
});

const { storeStatus } = load([sliceFn('site/_worker.js', 'storeStatus')]);

// KV, not an asset: a file under site/ is a build watch path, so committing the reading redeployed
// the site whenever Google moved a number and `siteUpdated` in the footer - which is that deploy's
// own timestamp - would have announced the site updated for a change somewhere else entirely.
const kv = (v) => ({ STATUS: { get: async () => v } });

test('an empty KV reads as "nobody could ask", never as "you are up to date"', async () => {
  // The one wrong answer with a cost, one layer below the tagsAhead case above. `cws` is what makes
  // /emergency say it could not ask; a missing reading that arrived as a plain absence of versions
  // would render as the in-step message over a Store nobody had spoken to.
  for (const empty of [null, undefined]) {
    const s = await storeStatus(kv(empty));
    assert.equal(s.cws, 'no-file', `empty KV must not read as ok (${String(empty)})`);
    assert.equal(s.crm, null);
    assert.equal(s.asOf, null);
  }
  // No binding at all - the state between adding the workflow and creating the namespace.
  assert.equal((await storeStatus({})).cws, 'no-file');
});

test('a KV that throws is reported, not swallowed into a good-looking answer', async () => {
  const s = await storeStatus({ STATUS: { get: async () => { throw new Error('down'); } } });
  assert.equal(s.cws, 'unreadable');
  assert.equal(s.analytics, null);
});

test('a reading is passed through with its asOf', async () => {
  const s = await storeStatus(kv({ crm: { published: { version: '1.39.0' } }, analytics: null,
                                   cws: 'ok', asOf: '2026-08-12T10:48:12Z' }));
  assert.equal(s.crm.published.version, '1.39.0');
  assert.equal(s.asOf, '2026-08-12T10:48:12Z');
  // Absent per-app blocks stay null rather than becoming undefined: the pages test them with `!v.store`.
  assert.equal(s.analytics, null);
});

test('with no Store version, nothing is offered rather than everything', () => {
  // The one wrong answer with a cost. Without a baseline the honest output is an empty list: a page
  // built on "here is every tag I can see" would tell a reader to install by hand over an
  // installation that may already be newer than any of them.
  assert.equal(tagsAhead(feed, 'crm', null).length, 0);
  assert.equal(tagsAhead(feed, 'crm', '').length, 0);
  assert.equal(tagsAhead(feed, 'crm', 'not-a-version').length, 0);
});

test('the legacy bare tag belongs to no product and is never offered', () => {
  // Same tag, same reason as the badge: `v1.0.0` predates the per-product scheme, and offering it to
  // somebody as an upgrade would be offering them a download of neither extension.
  assert.equal(tagsAhead(feed, 'analytics', '1.0.0').map((t) => t.tag).join(' '), 'analytics-v1.23.0');
});

test('a release named twice in one entry is offered once', () => {
  // Atom entries carry the tag in more than one element. Reading them all is right; offering the
  // same download twice is not.
  const twice = '<entry><link href="https://github.com/ivannot/zoost/releases/tag/crm-v1.40.0"/>' +
                '<id>https://github.com/ivannot/zoost/releases/tag/crm-v1.40.0</id></entry>';
  assert.equal(tagsAhead(twice, 'crm', '1.39.0').map((t) => t.version).join(' '), '1.40.0');
});

test('a Store version with fewer components compares as if the rest were zero', () => {
  // The Store reports what it is serving and IS_VERSION accepts two to four components, while a tag
  // always has three. 1.39 and 1.39.0 are the same release, and a comparator that indexed past the
  // end would have got NaN and called it ahead.
  assert.equal(tagsAhead(feed, 'crm', '1.39').map((t) => t.version).join(' '), '1.40.0');
});

test('the list is capped, so the fetches it causes are bounded', () => {
  assert.equal(tagsAhead(feed, 'crm', '1.0.0', 1).length, 1);
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

// The ledger is no longer read by the Worker at all. `pickSubmissions` and the four cases that
// covered it are gone with it: the badge rests on what Google reports, and a parser nothing calls
// is cover for code that is not there. The dates stay in RELEASES.md, where they are the human
// record of what was uploaded and nothing derives from them.

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

test('the cache key carries a marker that can be moved', () => {
  // The key ignores the query string on purpose, so a wrong entry cannot be busted from outside. It
  // therefore has to carry a marker, or a change in what gets cached is invisible until expiry.
  //
  // The *number* is deliberately not asserted. Pinning it made this go red on every correct bump -
  // the checker reporting the right change as a defect, which is how a suite stops being believed.
  // Whether the marker was bumped when it should have been is a judgement no test can make; that it
  // exists and is bumpable is the part that can be checked.
  assert.ok(/const CACHE_KEY = '\/api\/versions\?v=\d+';/.test(read('site/_worker.js')),
    'the cache key has no version marker, so a payload change would be invisible for an hour');
});


// ---------- what is actually in review ----------
//
// This used to be derived from RELEASES.md - the newest version recorded as submitted - which
// answered by proxy: a row typed after clicking Submit. `fetchStatus` answers directly and carries
// a *state*, so those cases live in pickStatus above. The date went with the ledger: the API never
// reported it, and how long a package has been in the queue is not worth a hand-kept copy of a fact.

// Reported from the live footer: «On the Web Store 1.38.4 · Latest release 1.39.0 not submitted
// yet» about a version that was in Google's review queue at that moment - /api/versions said
// PENDING_REVIEW in as many words. The state came from the API, the date from RELEASES.md, and the
// line read the row alone: with no row typed yet it announced the opposite of what the one
// authoritative source said. Run rather than grepped - a regex over the source would have agreed
// with every version of this logic, including the wrong one.
test('the release line says what Google says, and nothing when Google could not be asked', () => {
  const { releaseState } = load([
    sliceFn('site/site.js', 'verOf'),
    sliceFn('site/site.js', 'newer'),
    sliceFn('site/site.js', 'releaseState'),
  ]);
  const p = (version, state) => ({ version, state });
  const crm = (tag, pending) => ({ tag: tag, store: '1.38.4', pending: pending || null });
  // the reported case: Google has it in the queue
  assert.equal(releaseState(crm('crm-v1.39.0', p('1.39.0', 'PENDING_REVIEW')), true), 'awaiting');
  // genuinely not submitted: the API answered and has nothing
  assert.equal(releaseState(crm('crm-v1.39.0'), true), 'notSubmitted');
  // ...and the same payload when nobody could ask says nothing, rather than inventing a measurement
  assert.equal(releaseState(crm('crm-v1.39.0'), false), 'quiet');
  // refused: the line above says which, and «awaiting review» beside it would contradict it
  assert.equal(releaseState(crm('crm-v1.39.0', p('1.39.0', 'REJECTED')), true), 'quiet');
  // an older version is the one in the queue - that is the other line's subject
  assert.equal(releaseState(crm('crm-v1.40.0', p('1.39.0', 'PENDING_REVIEW')), true), 'quiet');
  // nothing to say at all: the tag is what the Store already serves
  assert.equal(releaseState(crm('crm-v1.38.4'), true), 'quiet');
  // a state nobody here recognises is not folded into «awaiting»
  assert.equal(releaseState(crm('crm-v1.39.0', p('1.39.0', 'SOMETHING_NEW')), true), 'quiet');
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

test('the three answers the emergency page can give are kept apart', () => {
  const box = { innerHTML: '' };
  const { renderAhead } = load([
    sliceConst('site/site.js', 'STR'),
    sliceFn('site/site.js', 't'),
    sliceFn('site/site.js', 'esc'),
    sliceFn('site/site.js', 'mdToHtml'),
    sliceFn('site/site.js', 'renderAhead'),
  ], { REPO_URL: 'https://github.com/ivannot/zoost', LANG: 'en', aheadBox: box });

  renderAhead({
    crm: { store: '1.39.0', latest: '1.40.0', pending: { version: '1.40.0', state: 'PENDING_REVIEW' },
           ahead: [{ version: '1.40.0', tag: 'crm-v1.40.0', zip: 'https://example.invalid/a.zip',
                     notes: '**Fixed.** A thing that was broken.' }] },
    analytics: { store: '1.23.0', latest: '1.23.0', pending: null, ahead: [] },
  });
  assert.ok(box.innerHTML.includes('https://example.invalid/a.zip'), 'the archive is not linked');
  assert.ok(box.innerHTML.includes('<b>Fixed.</b>'), 'the changelog is not rendered');
  assert.ok(box.innerHTML.includes('submitted, awaiting review'), 'the queue state is not stated');
  assert.ok(box.innerHTML.includes('Nothing to do here'), 'the product in step does not say so');

  // The one that has to be its own answer. A Store version with no tag feed is not "you are up to
  // date" - it is a comparison that could not be made, and rendering it as the calm case would send
  // somebody back to a broken extension believing they had checked.
  renderAhead({
    crm: { store: null, latest: null, ahead: [] },
    analytics: { store: '1.23.0', latest: null, ahead: [] },
  });
  assert.equal((box.innerHTML.match(/could not be asked/g) || []).length, 2,
    'a comparison that could not be made is being reported as one that came out even');
  assert.ok(!box.innerHTML.includes('Nothing to do here'), 'unknown is being rendered as in step');
  assert.ok(!/box warn/.test(box.innerHTML), 'nothing is ahead, so nothing should be flagged');
});

test('a reading that stopped advancing is called old, and only then', () => {
  const { staleReading } = load([
    sliceConst('site/site.js', 'STALE_AFTER_MS'),
    sliceFn('site/site.js', 'staleReading'),
  ]);
  const now = Date.parse('2026-08-12T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600e3).toISOString();

  // The workflow writes on every run, so the only thing an old date can mean is that runs stopped.
  assert.equal(staleReading(ago(0.5), now), false, 'a reading half an hour old is the normal case');
  assert.equal(staleReading(ago(6), now), false, "GitHub's cron jitter must not read as a failure");
  assert.equal(staleReading(ago(23.9), now), false, 'just inside a day is not old');
  assert.equal(staleReading(ago(24), now), false, 'the boundary itself is not past it');
  assert.equal(staleReading(ago(25), now), true, 'a day of missed runs is not being reported');
  assert.equal(staleReading(ago(72), now), true);

  // A clock set behind the one that wrote the reading gives a negative age. Not stale - and more to
  // the point, not something to announce to somebody whose extension has just stopped working.
  // It has to be further out than the threshold: at five hours in the future this passes whether the
  // age is signed or absolute, which is what the first version of this case did and proved nothing.
  assert.equal(staleReading(ago(-30), now), false, 'a future date is being called old');
  assert.equal(staleReading(ago(-5), now), false);

  // A date nothing can parse is a different fault, and it already shows as the line not being drawn
  // at all. Reporting it as staleness would name the wrong problem, which this project holds to be
  // worse than saying nothing.
  assert.equal(staleReading('not a date', now), false);
  assert.equal(staleReading('', now), false);
  assert.equal(staleReading(undefined, now), false);
});

test('the page says how tired the reading is without judging the reading', () => {
  const box = { innerHTML: '' };
  const render = (lang, asOf) => {
    box.innerHTML = '';
    const { renderAhead } = load([
      sliceConst('site/site.js', 'STR'),
      sliceConst('site/site.js', 'STALE_AFTER_MS'),
      sliceFn('site/site.js', 't'),
      sliceFn('site/site.js', 'esc'),
      sliceFn('site/site.js', 'fmtDate'),
      sliceFn('site/site.js', 'staleReading'),
      sliceFn('site/site.js', 'mdToHtml'),
      sliceFn('site/site.js', 'renderAhead'),
    ], { REPO_URL: 'https://github.com/ivannot/zoost', LANG: lang, aheadBox: box });
    renderAhead({ crm: { store: '1.39.0', latest: '1.39.0', ahead: [] },
                  analytics: { store: '1.23.0', latest: '1.23.0', ahead: [] },
                  storeAsOf: asOf });
    return box.innerHTML;
  };

  const fresh = render('en', new Date(Date.now() - 20 * 60e3).toISOString());
  assert.ok(fresh.includes('The Store was last asked'), 'the date is not printed at all');
  assert.ok(!fresh.includes('older than usual'), 'a reading twenty minutes old is being flagged');

  const old = render('en', new Date(Date.now() - 3 * 864e5).toISOString());
  assert.ok(old.includes('older than usual'), 'a three-day-old reading is passed off as current');
  // The yardstick travels with the claim: without it "older than usual" is a verdict the reader
  // cannot size, which is the thing this page refuses to hand out.
  assert.ok(old.includes('every half hour'), 'the interval that makes the age readable is missing');
  // It stays a note about the measurement. An amber box here would be the flashing sign the page was
  // designed not to be, and would read as a verdict on the versions rather than on the check.
  assert.ok(/class="meta"[^>]*>[^<]*older than usual/.test(old.replace(/\n/g, '')),
    'the staleness sentence has left the quiet meta line');
  // Not the conclusion, deliberately: the reader draws it from the interval and the date.
  assert.ok(!/may have moved/.test(old), 'the page has started concluding for the reader');

  const oldIt = render('it', new Date(Date.now() - 3 * 864e5).toISOString());
  assert.ok(oldIt.includes('pi\u00f9 vecchia del solito'), 'the Italian page falls back to English here');
  assert.ok(!oldIt.includes('older than usual'), 'both languages are being emitted at once');
});

test('the changelog is escaped before any of it is turned back into markup', () => {
  const { mdToHtml } = load([
    sliceFn('site/site.js', 'esc'),
    sliceFn('site/site.js', 'mdToHtml'),
  ]);
  // /emergency drops the release notes into innerHTML. They are our own files, fetched over a
  // network - and "we wrote it" is not a security model, it is an assumption about every future
  // edit to a directory nothing else validates.
  assert.equal(mdToHtml('<img src=x onerror=alert(1)>'),
               '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  // The subset that is put back is applied to the escaped text, in that order, so no tag can be
  // smuggled in through it.
  assert.equal(mdToHtml('**Three more data centres.** Now on `zoho.sa`.'),
               '<p><b>Three more data centres.</b> Now on <code>zoho.sa</code>.</p>');
  // A blank line is a paragraph; a single newline is where the file wraps, which is not structure.
  assert.equal(mdToHtml('one\ntwo\n\nthree'), '<p>one two</p><p>three</p>');
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

// ---------- the head, which nothing was holding ----------
//
// Open Graph, the canonical/og:url agreement, the landmark and the skip link were all fixed by hand
// after an outside review, and nothing then stopped the next page from shipping without them - the
// pages are written by copying a neighbour's head block, which is exactly how `og:url` came to
// disagree with the canonical on five pages in the first place. Derived from the directory, so a
// page added tomorrow is covered without anyone remembering.

test('every page declares one canonical, and og:url agrees with it', () => {
  for (const f of listPages()) {
    const s = read(f);
    if (f.endsWith('404.html')) continue;              // served everywhere, canonical for nothing
    const can = s.match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(can, `id=${f} has no canonical`);
    const og = s.match(/<meta property="og:url" content="([^"]+)"/);
    assert.ok(og, `id=${f} has no og:url`);
    assert.equal(og[1], can[1],
      `id=${f} tells a search engine one URL and a social card another`);
  }
});

test('every page has a main landmark and a skip link that points into it', () => {
  for (const f of listPages()) {
    const s = read(f);
    assert.ok(/<main\b/.test(s), `id=${f} has no <main>: the browser's own skip has no target`);
    const skip = s.match(/<a class="skip" href="#([^"]+)"/);
    assert.ok(skip, `id=${f} has no skip link`);
    assert.ok(new RegExp('id="' + skip[1] + '"').test(s),
      `id=${f} skips to #${skip[1]}, which is not on the page`);
  }
});

test('every page carries a description and a card type', () => {
  for (const f of listPages()) {
    const s = read(f);
    if (f.endsWith('404.html')) continue;              // deliberately noindex, and shared by no URL
    // 160 characters, because that is roughly where Google stops printing it. The point is not
    // brevity - it is that the sentence has to *close* before the cut, or the search result shows a
    // thought that stops halfway. Seven pages were over 230 and read as truncated in the wild.
    const d = s.match(/<meta name="description" content="([^"]*)"/);
    assert.ok(d && d[1].length >= 40, `id=${f} has no description`);
    assert.ok(d[1].length <= 160, `id=${f} description is ${d[1].length} characters and will be cut`);
    const og = s.match(/<meta property="og:description" content="([^"]*)"/);
    assert.ok(og, `id=${f} has no og:description`);
    assert.equal(og[1], d[1], `id=${f} tells a search engine one summary and a social card another`);
    assert.ok(/<meta name="twitter:card"/.test(s), `id=${f} has no twitter:card`);
    assert.ok(/<meta property="og:image"/.test(s), `id=${f} has no og:image`);
  }
});

/* The report page's two states.
 *
 * Reported: arriving at /it/report from a bookmark showed an empty locked box under «this is what
 * will be sent», which reads as broken software. The page cannot know who arrived - the panel writes
 * after load, a bookmark never writes - so it opens in the state that needs no arrival and moves when
 * text lands. These run the real file against a fake DOM, because a mode machine is only ever proven
 * by running it.
 */
const reportPage = (opts = {}) => {
  const el = () => ({ style: { display: '' }, value: '', textContent: '', innerHTML: '',
    readOnly: true, disabled: false, dataset: {}, focus() {}, listeners: {},
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); } });
  const els = {};
  const sent = [];
  // The message table comes off the shipped page, so these cases assert the sentences a reader
  // actually gets - not a set the test invented and would keep passing over.
  const tag = read('site/report.html').match(/<p id="msg"[\s\S]*?>/)[0];
  els.msg = el();
  for (const m of tag.matchAll(/data-(\w+)="([^"]*)"/g)) els.msg.dataset[m[1]] = m[2];
  const doc = {
    getElementById(id) { return (els[id] ||= el()); },
    querySelector(sel) {
      if (sel.indexOf('hreflang') !== -1) return (els.langlink ||= el());
      return opts.noWidget ? null : { value: 'a-token' };
    },
  };
  const ctx = vm.createContext({
    document: doc, window: {},
    fetch: (url, init) => { sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ url: 'https://x/1' }) }); },
  });
  vm.runInContext(read('site/report.js'), ctx);
  return { els, sent, get: (id) => doc.getElementById(id),
    say(text) { doc.getElementById('says').value = text; },
    arrive(text) { els.body.value = text; els.body.listeners.input.forEach((f) => f()); },
    type(text) { els.body.value = text; els.body.listeners.input.forEach((f) => f()); },
    send() { els.send.onclick(); } };
};

test('the page opens in the state a reader with no report arrives in', () => {
  const p = reportPage();
  // The script never even asks for the trace block until a report arrives: the markup's own state
  // is the by-hand one, so a reader with JavaScript off sees the same thing rather than a page that
  // never finishes loading.
  assert.equal(p.els.trace, undefined, 'the script touches the trace block on load');
  assert.equal(p.sent.length, 0);
});

test('the trace appears when the panel writes, and not before', () => {
  const p = reportPage();
  p.arrive('Zoost 1.0 · Chrome\n\nwhat happened\n  boom');
  for (const id of ['trace', 'subpanel', 'addpanel', 'addheadpanel']) {
    assert.equal(p.els[id].style.display, '', `id=${id} should be shown once a report has arrived`);
  }
  for (const id of ['subhand', 'addhand', 'addhead']) {
    assert.equal(p.els[id].style.display, 'none', `id=${id} should be gone once a report has arrived`);
  }
});

test('a report written by hand is sent as one, and says so', () => {
  const p = reportPage();
  p.say('The panel will not open on Firefox.');
  p.send();
  assert.equal(p.sent.length, 1);
  const b = p.sent[0].body;
  assert.equal(b.hand, true, 'a hand-written report must be labelled as one, or it reads as evidence');
  assert.equal(b.edited, false);
  assert.ok(/^Zoost /.test(b.report), 'the endpoint refuses anything that does not begin with Zoost');
  assert.equal(b.says, 'The panel will not open on Firefox.');
});

test('a hand-written report with nothing in it is not sent', () => {
  const p = reportPage();
  p.send();
  assert.equal(p.sent.length, 0, 'an empty description is the whole of what would be sent');
  assert.ok(/describe the problem/.test(p.get('msg').textContent));
});

test('a report from the panel travels as a trace, and the notes stay notes', () => {
  const p = reportPage();
  p.arrive('Zoost 1.0 · Chrome\n\nwhat happened\n  boom');
  p.say('I pressed Pull all.');
  p.send();
  const b = p.sent[0].body;
  assert.equal(b.hand, false);
  assert.equal(b.edited, false, 'nothing was edited, so nothing may say it was');
  assert.ok(b.report.includes('what happened'));
  assert.equal(b.says, 'I pressed Pull all.');
});

test('editing the trace is carried to the issue', () => {
  const p = reportPage();
  p.arrive('Zoost 1.0 · Chrome\n\nwhat happened\n  boom');
  p.type('Zoost 1.0 · Chrome\n\nwhat happened\n  (cut)');
  assert.equal(p.els.editedNote.style.display, '', 'the reader is not told their report is marked');
  p.send();
  assert.equal(p.sent[0].body.edited, true);
});

test('the report page hides the trace and shows the by-hand text in its markup', () => {
  for (const f of ['site/report.html']) {
    const s = read(f);
    assert.ok(/<div id="trace" style="display:none">/.test(s), `id=${f} shows an empty trace box`);
    assert.ok(/id="subpanel" style="display:none"/.test(s), `id=${f} claims a panel wrote something`);
    assert.ok(/<p class="sub" id="subhand">/.test(s), `id=${f} has nothing for a reader who arrives cold`);
  }
});

test('the language link goes when a trace arrives, because following it would lose the report', () => {
  const p = reportPage();
  p.arrive('Zoost 1.0 · Chrome\n\nwhat happened\n  boom');
  assert.equal(p.els.langlink.style.display, 'none',
    'the header still offers a navigation that throws the report away without saying so');
});



test('the report page is English only, and nothing points at a translation of it', () => {
  // Decided rather than drifted: the panel is English, the issue tracker is English, and a page
  // that exists in two languages needs the panel to choose one - so there is one page. The check
  // exists because the opposite is a href away, and a link to a page that does not exist answers 404.
  assert.ok(!existsSync(new URL('../site/it/report.html', import.meta.url)),
    'site/it/report.html is back - it was removed on purpose, one page or two is a decision');
  for (const f of listPages().concat(['site/report.js', 'apps/crm/sidepanel.js', 'apps/analytics/sidepanel.js'])) {
    assert.ok(!read(f).includes('/it/report'), `id=${f} points at a page that does not exist`);
  }
});

test('the messages the page shows are in the page script, in one language', () => {
  const js = read('site/report.js');
  assert.ok(!/\bM\.\w+/.test(js), 'a per-language message table outlived the second language');
  assert.ok(js.includes('Keep that '), 'the sender is not told the link is their only way back');
});

test('the anti-abuse widget is drawn only when it has something to ask', () => {
  // Reported after the first real send: a green «Success!» box sitting above an unpressed button
  // reads as «this has been sent». interaction-only draws nothing in the ordinary case - so the
  // message for a missing token may not point at anything on screen, and must not say «above».
  const html = read('site/report.html');
  assert.ok(/data-appearance="interaction-only"/.test(html),
    'the widget announces itself before the reader has sent anything');
  const js = read('site/report.js');
  assert.ok(!/Please complete the check above first/.test(js),
    'the page points the reader at a widget that is not drawn');
});

test('every control on the report page says it can be clicked', () => {
  // A <button> gets no pointer from the browser; an <a> does. `.btn` was written for links, so the
  // day it was first put on a real button - Send - the button looked dead. Derived rather than
  // listed: every class on a <button> in a shipped page must carry a cursor somewhere in site.css.
  const css = read('site/site.css');
  const rule = (cls) => {
    const m = css.match(new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*\\}`, 'g')) || [];
    return m.join(' ');
  };
  for (const f of listPages().filter((p) => p.endsWith('.html'))) {
    for (const m of read(f).matchAll(/<button[^>]*class="([^"]+)"/g)) {
      const classes = m[1].split(/\s+/);
      assert.ok(classes.some((c) => /cursor:\s*pointer/.test(rule(c))),
        `id=${f} draws a button with class "${m[1]}" that no rule gives a pointer`);
    }
  }
});
