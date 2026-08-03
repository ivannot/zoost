/*
 * /api/versions — Cloudflare Pages Function.
 *
 * Reports the version Zoost is at in each place it lives, so the site can show whether they are in
 * step: the Chrome Web Store, the newest git tag, and when the site content last changed.
 *
 * Three deliberate properties:
 *  - Every source fails on its own. One being down or blocked returns null for that field and the
 *    others still answer; the page then shows "unknown" for that one only.
 *  - Nothing is ever guessed. A value that does not look like a version is discarded rather than
 *    displayed, so a change in Google's markup can only cost us the number — never invent one.
 *  - Answers are cached at the edge for an hour, which keeps us far inside GitHub's unauthenticated
 *    rate limit and means a brief upstream failure is invisible.
 *
 * The store number is scraped from the listing page because Google publishes no API for it. That is
 * a DOM contract we do not own and it will break one day — acceptable *here*, on an informational
 * page where the cost is a missing badge. The extension itself must never depend on anything like
 * this (see CLAUDE.md, "Do what you're certain of, or stop").
 */

const REPO = 'ivannot/zoost';
const EXT_ID = 'flffecjpbmjfonhoojaiemgjanbjkmpj';
const TTL = 3600;                       // seconds
const UA = 'zoost.it version badge (+https://zoost.it)';
const IS_VERSION = /^\d+(\.\d+){1,3}$/; // the shape guard: anything else is not a version

const timeout = (ms) => AbortSignal.timeout(ms);

// Newest git tag. Tags are sorted here rather than trusting the API's order, which is not specified.
async function latestTag() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  const tags = await r.json();
  if (!Array.isArray(tags)) return null;
  const semver = tags
    .map((t) => String(t.name || ''))
    .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const pa = a.replace(/^v/, '').split('.').map(Number);
      const pb = b.replace(/^v/, '').split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  return semver[0] || null;
}

// Published version on the Chrome Web Store. No API exists, so this reads the listing page and only
// accepts a value shaped like a version.
async function storeVersion() {
  const r = await fetch(`https://chromewebstore.google.com/detail/${EXT_ID}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: timeout(8000),
  });
  if (!r.ok) return null;
  const html = await r.text();
  for (const m of html.matchAll(/class="nBZElf">([^<]{1,24})</g)) {
    const v = m[1].trim();
    if (IS_VERSION.test(v)) return v;   // shape guard — see the header note
  }
  return null;
}

// When the site content itself last changed. GitHub knows this without any credential, and it is
// truer than a deploy timestamp: it is when the pages actually changed.
async function siteUpdated() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits?path=site&per_page=1`, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  const commits = await r.json();
  const d = Array.isArray(commits) && commits[0]?.commit?.committer?.date;
  return d || null;
}

const settled = (p) => p.then((v) => v).catch(() => null);

export async function onRequest(context) {
  const { request, waitUntil } = context;
  const cache = caches.default;
  const key = new Request(new URL('/api/versions', request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const [store, tag, updated] = await Promise.all([
    settled(storeVersion()), settled(latestTag()), settled(siteUpdated()),
  ]);

  const res = new Response(JSON.stringify({
    store, tag, siteUpdated: updated, checked: new Date().toISOString(),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${TTL}`,
    },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
