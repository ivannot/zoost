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

test('an annotated tag is found even though its title carries the message', () => {
  // This is the bug. release.sh cuts annotated tags, and GitHub titles those entries
  // `name: first line of the message`. The old filter demanded an exact match on the whole title,
  // so it could only ever match a lightweight tag — every real release would have read as
  // "nothing released yet", which is indistinguishable from a project that has shipped nothing.
  const xml = `<title>Tags from zoost</title>
    <title>analytics-v1.0.0: Zoost for Zoho Analytics 1.0.0 — first Chrome Web Store submission</title>
    <title>v1.0.0</title>`;
  assert.equal(pickLatestTag(xml, 'analytics'), 'analytics-v1.0.0');
});

test('a lightweight tag, with no message, is found too', () => {
  assert.equal(pickLatestTag('<title>crm-v2.0.0</title>', 'crm'), 'crm-v2.0.0');
});

test('the legacy bare tag belongs to no product and is never returned', () => {
  // `v1.0.0` was published as the state of the project for a while: the filter accepted it and
  // rejected every per-product tag, so the site announced the oldest ref in the repository.
  const xml = '<title>Tags from zoost</title><title>v1.0.0</title>';
  assert.equal(pickLatestTag(xml, 'crm'), null);
  assert.equal(pickLatestTag(xml, 'analytics'), null);
});

test('versions sort numerically, not lexically', () => {
  const xml = ['crm-v1.8.1: a', 'crm-v1.10.0', 'crm-v1.9.0: b']
    .map((t) => `<title>${t}</title>`).join('');
  assert.equal(pickLatestTag(xml, 'crm'), 'crm-v1.10.0');   // "1.10.0" < "1.9.0" as strings
});

test('one product never answers with the other product\'s tag', () => {
  const xml = '<title>crm-v3.0.0</title><title>analytics-v2.0.0</title>';
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
