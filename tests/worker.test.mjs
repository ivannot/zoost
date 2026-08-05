/*
 * The site's Worker: the two things it parses out of pages it does not control.
 *
 * Both cases below are failures that reached zoost.it. Nothing here talks to the network — the
 * fetching is not the interesting part, and a test that needs GitHub to be up is a test that fails
 * for reasons that are not about us.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceFn, sliceConst, load } from './slice.mjs';

// Sliced rather than imported: _worker.js is an ES module but node reads a bare .js as CommonJS,
// and a package.json at the repo root to change that would be a build-system decision taken by the
// tests. The tests do not get to reshape the project.
const { pickLatestTag, pickStoreVersion } = load([
  sliceConst('site/_worker.js', 'IS_VERSION'),
  sliceFn('site/_worker.js', 'pickLatestTag'),
  sliceFn('site/_worker.js', 'pickStoreVersion'),
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

test('the store scrape returns a version, or nothing — never a guess', () => {
  // The shape guard is the promise that a change in Google's markup costs us the number and never
  // invents one. A promise is worth what its test is worth.
  assert.equal(pickStoreVersion('<span class="nBZElf">1.9.0</span>'), '1.9.0');
  assert.equal(pickStoreVersion('<span class="nBZElf">Updated today</span>'), null);
  assert.equal(pickStoreVersion('<span class="nBZElf"></span>'), null);
  assert.equal(pickStoreVersion('nothing that looks like the listing at all'), null);
});

test('the first value that looks like a version wins, later prose is not consulted', () => {
  const html = '<span class="nBZElf">1.2.3</span><span class="nBZElf">4.5.6</span>';
  assert.equal(pickStoreVersion(html), '1.2.3');
});

// ---------- the gap between what is released and what the Store serves ----------

const { verOf, newer } = load([
  sliceFn('site/site.js', 'verOf'),
  sliceFn('site/site.js', 'newer'),
]);

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
