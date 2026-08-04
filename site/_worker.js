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
// One listing per product. Both are published, so the badge reports both — a badge that named one
// of two would be the "declare only what we have" rule broken in the direction of saying less.
const EXT_ID = {
  crm: 'flffecjpbmjfonhoojaiemgjanbjkmpj',
  analytics: 'gmelnigbgklfjgceldicakkomhgplgge',
};
const TTL = 3600;                       // seconds
const UA = 'zoost.it version badge (+https://zoost.it)';
const IS_VERSION = /^\d+(\.\d+){1,3}$/; // the shape guard: anything else is not a version

const timeout = (ms) => AbortSignal.timeout(ms);

// Newest git tag **per product**, read from GitHub's Atom feed rather than its JSON API.
//
// api.github.com allows 60 unauthenticated requests an hour *per IP*, and this Worker goes out
// through Cloudflare's shared egress addresses — where that budget is spent by traffic that has
// nothing to do with us. The result was three of the four fields coming back null most of the time.
// The Atom feeds on github.com carry the same facts without that limit and without a credential.
// They are XML, so the parsing is deliberately shallow and every value still passes a shape guard.
//
// This asked for "the newest tag" and got a wrong answer that looked right. The filter accepted
// `v1.0.0` and rejected `analytics-v1.0.0`, so the site published the one legacy tag — older than
// everything, and belonging to neither product — as the state of the project. With one tag per
// product a single "latest tag" is not an ambiguous fact, it is not a fact at all: the question
// only means anything once you say which extension you are asking about.
async function latestTag(app) {
  const r = await fetch(`https://github.com/${REPO}/tags.atom`, {
    headers: { 'user-agent': UA, accept: 'application/atom+xml' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  const xml = await r.text();
  // An **annotated** tag's entry is titled `name: first line of the message`, not `name` — and every
  // tag this project cuts from now on is annotated, because release.sh uses `git tag -a`. The old
  // filter demanded an exact match against the whole title, so it could only ever have matched the
  // one lightweight legacy tag, and every real release would have gone missing in a way that looks
  // like "nothing has been released yet". Hence the optional `: …` tail, and a title window wide
  // enough to hold a message rather than truncating it into a non-match.
  const re = new RegExp(`^(${app}-v(\\d+\\.\\d+\\.\\d+))(?::|$)`);
  const tags = [...xml.matchAll(/<title>([^<]{1,200})<\/title>/g)]
    .map((m) => re.exec(m[1].trim()))
    .filter(Boolean)                              // also drops the feed's own title
    .sort((a, b) => {
      const pa = a[2].split('.').map(Number);
      const pb = b[2].split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  return tags.length ? tags[0][1] : null;   // the tag name alone: it is what you check out
}

// Published version on the Chrome Web Store. No API exists, so this reads the listing page and only
// accepts a value shaped like a version.
async function storeVersion(app) {
  const r = await fetch(`https://chromewebstore.google.com/detail/${EXT_ID[app]}`, {
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
const CACHE_KEY = '/api/versions?v=9';   // bumped: the CRM guide moved to docs-crm.html

async function versions(request, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(CACHE_KEY, request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const [crmStore, crmRepo, crmTag, anStore, anRepo, anTag, updated, docsUpd, docsAnUpd] =
    await Promise.all([
      settled(storeVersion('crm')), settled(repoVersion('crm')), settled(latestTag('crm')),
      settled(storeVersion('analytics')), settled(repoVersion('analytics')),
      settled(latestTag('analytics')),
      settled(lastChanged('site')), settled(lastChanged('site/docs-crm.html')),
      settled(lastChanged('site/docs-analytics.html')),
    ]);

  const res = new Response(JSON.stringify({
    // `store`, `repo` and `tag` are kept alongside the per-product blocks so a page served from
    // cache before this shape existed still renders something true rather than nothing. `tag` is
    // deliberately CRM's rather than the old repo-wide value: an unqualified one was the bug.
    store: crmStore, repo: crmRepo, tag: crmTag,
    crm: { store: crmStore, repo: crmRepo, tag: crmTag },
    analytics: { store: anStore, repo: anRepo, tag: anTag },
    siteUpdated: updated, docsUpdated: docsUpd, docsAnalyticsUpdated: docsAnUpd,
    checked: new Date().toISOString(),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${TTL}`,
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// `/docs` used to be the Zoho CRM guide, which made the generic URL the property of one product
// while the other had to carry its name in the path. The guides are `/docs-crm` and
// `/docs-analytics` now, and `/how-to` is the neutral way in.
//
// The old path must never 404, and not merely for tidiness: **Zoost for Zoho CRM 1.9.0 has
// `zoost.it/docs.html` compiled into it** and is in review as this ships. A published extension
// cannot be asked to change, so the site keeps its side of that contract permanently. 301 rather
// than 302 so search engines move rather than keep asking.
const MOVED = {
  '/docs': '/docs-crm.html',
  '/docs.html': '/docs-crm.html',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/versions') return versions(request, ctx);
    const to = MOVED[url.pathname];
    if (to) return Response.redirect(new URL(to, url).toString(), 301);
    return env.ASSETS.fetch(request);   // everything else is a file, served as before
  },
};
