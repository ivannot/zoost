/*
 * zoost.it Worker. Everything is a static asset except /api/versions, which this script answers.
 *
 * Assets are served first by the platform; this script only runs when no file matches, so the site
 * behaves exactly as before and this endpoint is the single addition. `functions/` was the wrong
 * shape entirely — that is a Cloudflare Pages convention and this project is a Worker.
 *
 * Reports the version Zoost is at in each place it lives, so the site can show whether they are in
 * step: the Chrome Web Store, the newest git tag, and when the site content last changed.
 *
 * Three deliberate properties:
 *  - Every source fails on its own. One being down or blocked returns null for that field and the
 *    others still answer; the page then shows "unknown" for that one only.
 *  - Nothing is ever guessed. A value that does not look like a version is discarded rather than
 *    displayed, so a change in Google's markup can only cost us the number — never invent one.
 *  - Answers are cached at the edge for an hour, so a brief upstream failure is invisible.
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

// Newest git tag, read from GitHub's Atom feed rather than its JSON API.
//
// api.github.com allows 60 unauthenticated requests an hour *per IP*, and this Worker goes out
// through Cloudflare's shared egress addresses — where that budget is spent by traffic that has
// nothing to do with us. The result was three of the four fields coming back null most of the time.
// The Atom feeds on github.com carry the same facts without that limit and without a credential.
// They are XML, so the parsing is deliberately shallow and every value still passes a shape guard.
async function latestTag() {
  const r = await fetch(`https://github.com/${REPO}/tags.atom`, {
    headers: { 'user-agent': UA, accept: 'application/atom+xml' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  const xml = await r.text();
  const semver = [...xml.matchAll(/<title>([^<]{1,40})<\/title>/g)]
    .map((m) => m[1].trim())
    .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n))   // also drops the feed's own title
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

// The version the code is at right now, straight from the manifest on the default branch. This is
// deliberately not the same thing as the tag: it is what is built, not what has been released, and
// the badge labels it "in development" so nobody reads it as something they can install.
async function repoVersion(app) {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/apps/${app}/manifest.json`, {
    headers: { 'user-agent': UA }, signal: timeout(6000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const v = String((j && j.version) || '').trim();
  return IS_VERSION.test(v) ? v : null;   // same shape guard as the rest
}

// When a given path last changed. GitHub knows this without any credential, and it is truer than a
// deploy timestamp: it is when the content actually changed. Asked per path on purpose — a guide
// that claims to have been updated because the homepage changed is claiming something false.
async function lastChanged(path) {
  const r = await fetch(`https://github.com/${REPO}/commits/main/${path}.atom`, {
    headers: { 'user-agent': UA, accept: 'application/atom+xml' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  const xml = await r.text();
  const m = xml.match(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/);   // first entry = newest commit
  const d = m && m[1].trim();
  return d && !isNaN(Date.parse(d)) ? d : null;   // shape guard: must be a real timestamp
}

const settled = (p) => p.then((v) => v).catch(() => null);

// The cache key carries a version marker, and it must be bumped whenever the payload's shape
// changes. The key deliberately ignores the query string — otherwise anyone could fill the cache
// with junk keys — which also means a stale entry cannot be busted from outside. Without this
// marker a deploy is invisible for up to an hour: the new code runs, hits the old cached response
// and returns it unchanged. That is exactly what happened when `repo` was added.
const CACHE_KEY = '/api/versions?v=5';

async function versions(request, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(CACHE_KEY, request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const [store, tag, repo, updated, docsUpd] = await Promise.all([
    settled(storeVersion()), settled(latestTag()), settled(repoVersion('crm')),
    settled(lastChanged('site')), settled(lastChanged('site/docs.html')),
  ]);

  const res = new Response(JSON.stringify({
    store, tag, repo, siteUpdated: updated, docsUpdated: docsUpd, checked: new Date().toISOString(),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${TTL}`,
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/api/versions') return versions(request, ctx);
    return env.ASSETS.fetch(request);   // everything else is a file, served as before
  },
};
