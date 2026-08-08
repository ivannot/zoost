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
const TTL = 3600;                       // seconds, when every source answered
const TTL_PARTIAL = 60;                 // …and when one did not, so an outage expires with the outage
const UA = 'zoost.it version badge (+https://zoost.it)';
const IS_VERSION = /^\d+(\.\d+){1,3}$/; // the shape guard: anything else is not a version

const timeout = (ms) => AbortSignal.timeout(ms);
const listing = (app) => `https://chromewebstore.google.com/detail/${EXT_ID[app]}`;

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
  return pickLatestTag(await r.text(), app);
}

// The parsing, separated from the fetching so it can be tested against real feed text. This is
// where the bug was: not in reaching GitHub, but in reading what it sent back.
export function pickLatestTag(xml, app) {
  // Read the tag out of each entry's **link**, never its title.
  //
  // The title is the Release's name once a Release exists, and a Release can be renamed: giving
  // crm-v1.9.0 the title "Zoost for Zoho CRM 1.9.0" made the tag vanish from this parser and the
  // footer reported "none yet" for a release that plainly existed. The href is
  // `…/releases/tag/<tag>` and is structural — it says what you would check out, whatever anyone
  // decided to call the release.
  const re = new RegExp(`/releases/tag/(${app}-v(\\d+\\.\\d+\\.\\d+))(?:"|/|$)`, 'g');
  const tags = [...xml.matchAll(re)]
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
  const r = await fetch(listing(app), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: timeout(8000),
  });
  if (!r.ok) return null;
  return pickStoreVersion(await r.text());
}

// Separated for the same reason: the shape guard is the promise that a change in Google's markup
// can only cost us the number, never invent one, and a promise is worth what its test is worth.
export function pickStoreVersion(html) {
  for (const m of html.matchAll(/class="nBZElf">([^<]{1,24})</g)) {
    const v = m[1].trim();
    if (IS_VERSION.test(v)) return v;   // shape guard — see the header note
  }
  return null;
}

// When a version was submitted to the Store, read from RELEASES.md — the same record a reader can
// check. Deriving this is the difference between "submission pending", which asserts something we
// have not measured, and "submitted on 4 August", which is a fact with a source. A tag can exist
// without ever having been submitted, so the two must not be conflated.
async function submissions() {
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/RELEASES.md`, {
    headers: { 'user-agent': UA }, signal: timeout(6000),
  });
  if (!r.ok) return {};
  return pickSubmissions(await r.text());
}

export function pickSubmissions(md) {
  const out = {};
  for (const line of md.split('\n')) {
    const c = line.split('|').map((x) => x.trim().replace(/^`|`$/g, ''));
    // | app | version | tag | commit | sha | submitted |
    if (c.length < 7) continue;
    const [, app, version, , , , when] = c;
    if (!/^(crm|analytics)$/.test(app) || !IS_VERSION.test(version)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) continue;      // shape guard: a real date or nothing
    out[app] = out[app] || {};
    out[app][version] = when;
  }
  return out;
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
const CACHE_KEY = '/api/versions?v=14';  // bumped: each product now carries what is actually in review

/** The newest version of `app` recorded as submitted, and when — regardless of what is tagged.
 *
 * `sub()` below answers "was *this tag* submitted", which is the right question for the release line
 * and the wrong one for everything else: tag a version and do not submit it, and the release that is
 * genuinely sitting in review disappears from the page. That is exactly what happened — Zoho CRM read
 * "Web Store 1.0.0 · latest release 1.11.0 not submitted yet", with no sign that 1.9.0 had been
 * submitted a day earlier and was still being reviewed. Every word was true and the page was wrong.
 */
function newestSubmitted(subs, app) {
  const rows = (subs && subs[app]) || {};
  let best = null;
  for (const [v, date] of Object.entries(rows)) {
    if (!IS_VERSION.test(v)) continue;
    if (!best || cmpVersion(v, best.version) > 0) best = { version: v, date };
  }
  return best;
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

async function versions(request, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(CACHE_KEY, request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const [crmStore, crmRepo, crmTag, anStore, anRepo, anTag, subs, updated, docsUpd, docsAnUpd] =
    await Promise.all([
      settled(storeVersion('crm')), settled(repoVersion('crm')), settled(latestTag('crm')),
      settled(storeVersion('analytics')), settled(repoVersion('analytics')),
      settled(latestTag('analytics')),
      settled(submissions()),
      settled(lastChanged('site')), settled(lastChanged('site/docs-crm.html')),
      settled(lastChanged('site/docs-analytics.html')),
    ]);
  const sub = (app, tag) => {
    const m = /-v(\d+\.\d+\.\d+)$/.exec(tag || '');
    return (m && subs && subs[app] && subs[app][m[1]]) || null;
  };

  // A source that failed is cached for a minute, not an hour. `settled()` turns a blip into null and
  // the page then says "unknown" — which is the honest word, and exactly the wrong thing to hold on to
  // for an hour after the source came back. This happened: one fetch to raw.githubusercontent failed,
  // and both submission dates read "unknown" long after the file was serving fine. Caching is there so
  // a blip is invisible; caching the blip itself is the opposite of that.
  const complete = [crmStore, crmRepo, crmTag, anStore, anRepo, anTag, subs, updated].every((v) => v != null);
  const ttl = complete ? TTL : TTL_PARTIAL;

  const res = new Response(JSON.stringify({
    // `store`, `repo` and `tag` are kept alongside the per-product blocks so a page served from
    // cache before this shape existed still renders something true rather than nothing. `tag` is
    // deliberately CRM's rather than the old repo-wide value: an unqualified one was the bug.
    store: crmStore, repo: crmRepo, tag: crmTag,
    // The listing URL comes from here rather than being written again in site.js: the extension
    // ids already live in this file, and a second copy is a second thing to go stale.
    // `submitted` answers "was this tag submitted"; `pending` answers "is anything in review", which
    // is a different question the moment a later tag exists that was not submitted.
    crm: { store: crmStore, repo: crmRepo, tag: crmTag, submitted: sub('crm', crmTag), pending: newestSubmitted(subs, 'crm'), url: listing('crm') },
    analytics: { store: anStore, repo: anRepo, tag: anTag, submitted: sub('analytics', anTag), pending: newestSubmitted(subs, 'analytics'), url: listing('analytics') },
    siteUpdated: updated, docsUpdated: docsUpd, docsAnalyticsUpdated: docsAnUpd,
    checked: new Date().toISOString(),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
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
// The target is the URL that answers 200. `/docs-crm.html` is itself 307'd to `/docs-crm` by the
// asset layer, so pointing here at the `.html` form would send a published extension's users through
// two redirects to reach one page — and it is the same confusion between a file's path and its URL
// that made every canonical on this site point at a redirect.
const MOVED = {
  '/docs': '/docs-crm',
  '/docs.html': '/docs-crm',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/versions') return versions(request, ctx);
    const to = MOVED[url.pathname];
    if (to) return Response.redirect(new URL(to, url).toString(), 301);

    // Plain text is served as `text/plain` with no charset, so a browser falls back to guessing and
    // lands on Windows-1252: every em-dash in llms.txt arrived as `â€”`. HTML escapes this because
    // it declares its encoding in-band with a <meta> tag; a .txt file has no way to say it, so the
    // header is the only place it can be said. The file itself was valid UTF-8 all along.
    if (url.pathname.endsWith('.txt')) {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('content-type', 'text/plain; charset=utf-8');
      // Five minutes, not the default. llms.txt is a document that will change, and the edge cache
      // key ignores the query string — so a wrong response cannot be busted from outside and simply
      // has to expire. That is exactly what happened to the missing charset: the fix deployed and
      // the old header kept being served. A short TTL is what stops the next one lasting as long.
      headers.set('cache-control', 'public, max-age=300');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }

    return env.ASSETS.fetch(request);   // everything else is a file, served as before
  },
};
