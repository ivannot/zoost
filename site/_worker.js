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
 * The Store figures came from scraping the listing page for years, because the old API could not
 * report status and Google published nothing else. They come from the Chrome Web Store API now, read
 * with a service account, minting a token for `chromewebstore.readonly` — which is what this code
 * asks for. Whether the key could ask for more is not established: Google describes the
 * publisher-level grant as «manage items», and the scope is chosen at token time. That removes a DOM contract we
 * did not own, and it answers a question the scrape never could: whether a submission was
 * **rejected**, which is otherwise indistinguishable from one still in the queue.
 */

const REPO = 'ivannot/zoost';
// One listing per product. Both are published, so the badge reports both — a badge that named one
// of two would be the "declare only what we have" rule broken in the direction of saying less.
const EXT_ID = {
  crm: 'flffecjpbmjfonhoojaiemgjanbjkmpj',
  analytics: 'gmelnigbgklfjgceldicakkomhgplgge',
};
// Ten minutes, not an hour. The badge is a live status - what the Store is serving, what it has in
// the queue - and an hour of it was the difference between submitting and seeing it. Measured rather
// than guessed: a miss costs **9 upstream requests** (4 GitHub Atom feeds, 2 raw manifests, 2
// fetchStatus, 1 token mint), so this is 54 an hour per PoP against 9 - and «per PoP» is the term
// that matters, since Cloudflare caches per data centre and the total is that times however many are
// warm. The one number nobody here has is Google's quota on the Store API, which is the 2 of the 9
// worth watching if this is ever shortened further.
const TTL = 600;                        // seconds, when every source answered
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

// What the Chrome Web Store says about our items, asked of the Store rather than scraped off it.
//
// This used to parse the listing page for a `class="nBZElf"` span, because the old API had no way to
// report status and Google published nothing else. V2 does: `publishers.items.fetchStatus` returns
// the published revision and the submitted one, each with a state, and it is read through a service
// account, asking for `chromewebstore.readonly` — a *token* that cannot publish, cannot edit and
// cannot take anything down. That is a property of the request, not a limit Google is known to
// enforce on the key: treat any credential of this service account as one that can write. Three things improve at once: the DOM contract we did not own is gone,
// "in review" is Google saying so instead of a line we wrote in RELEASES.md, and **rejected** became
// expressible at all — before this, a refused submission would have left the badge claiming it was
// still in review for ever.
const CWS_API = 'https://chromewebstore.googleapis.com/v2';
const PUBLISHER = 'f3724a09-0185-4176-ab7e-3b1df03ca3b7';   // not a secret: it is in every dashboard URL

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemBytes(pem) {
  const raw = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

// The service-account JWT flow: sign a one-hour assertion with the account's private key and trade
// it for an access token. Nothing is stored between requests — the whole payload is cached for an
// hour anyway, so a token per computation costs one extra call and saves having a second thing that
// can go stale.
// Returns {token, why}. `why` is a short, deliberately non-secret reason, and it exists because
// "unknown" with no cause is the empty state this project refuses everywhere else: a missing binding,
// a revoked key and a malformed secret all produce the same null and need different fixes. Nothing in
// it identifies the credential - it names which step declined.
// `CWS_SERVICE_ACCOUNT` is a Cloudflare **Secret**, and it has to be in the Worker's *runtime*
// "Variables and secrets", not the one under Build. Those are two different boxes with nearly the
// same name: the build one is for the build step and never reaches `env`, so the value was set,
// visible in the dashboard, and the Worker still answered `no-credential`. Read the description, not
// the title - the runtime one says "used at runtime".
async function cwsToken(env) {
  if (!env || !env.CWS_SERVICE_ACCOUNT) return { token: null, why: 'no-credential' };
  let key;
  try {
    key = JSON.parse(env.CWS_SERVICE_ACCOUNT);
  } catch {
    return { token: null, why: 'credential-not-json' };
  }
  if (!key.client_email || !key.private_key) return { token: null, why: 'credential-incomplete' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(claim)));
  const signer = await crypto.subtle.importKey(
    'pkcs8', pemBytes(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, enc.encode(`${head}.${body}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${head}.${body}.${b64url(sig)}`,
    signal: timeout(8000),
  });
  if (!r.ok) return { token: null, why: 'token-http-' + r.status };
  const j = await r.json();
  return j && j.access_token ? { token: j.access_token, why: 'ok' }
                             : { token: null, why: 'token-empty' };
}

async function cwsStatus(token, app) {
  if (!token) return null;
  const r = await fetch(`${CWS_API}/publishers/${PUBLISHER}/items/${EXT_ID[app]}:fetchStatus`, {
    headers: { authorization: `Bearer ${token}` }, signal: timeout(8000),
  });
  if (!r.ok) return { http: r.status };
  return pickStatus(await r.json());
}

// Separated so it can be tested against a real response. Every version still passes the same shape
// guard the scrape used: a field that is not a version is discarded rather than displayed, because
// the promise has always been that a change at Google's end can cost us a number, never invent one.
export function pickStatus(d) {
  const rev = (x) => {
    if (!x || !x.state) return null;
    const ch = (x.distributionChannels || [])[0] || {};
    const v = String(ch.crxVersion || '').trim();
    return { state: x.state, version: IS_VERSION.test(v) ? v : null,
             deployPercentage: typeof ch.deployPercentage === 'number' ? ch.deployPercentage : null };
  };
  const published = rev(d && d.publishedItemRevisionStatus);
  const submitted = rev(d && d.submittedItemRevisionStatus);
  if (!published && !submitted) return null;
  return { published, submitted, takenDown: !!(d && d.takenDown) };
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

// When a given path last changed. GitHub knows this without any credential, and for a *guide* it is
// the right question: asked per path on purpose, because a guide claiming to have been updated
// because the homepage moved is claiming something false — and a deployment date would say exactly
// that. The site-wide date is the opposite question and takes the opposite answer (see `updated`
// below): «when did what I am reading go live», which a commit cannot answer.
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
const CACHE_KEY = '/api/versions?v=20';  // bumped: the TTL changed, so the entries written under v=19 would outlive it by an hour

// Turning on `assets.not_found_handling` took this endpoint away without touching a line of it:
// with a 404 page configured, a request that matches no asset stops reaching the Worker, and
// `/api/versions` matches no asset. It answered 404 for a fetch as well as for a navigation, so the
// footer badge and the guides' version stamp were dead on every page. `/api/*` is in
// `run_worker_first` now. Two lessons, and the second is the one that generalises: **a change to
// which requests reach the Worker is a change to every route the Worker owns**, and the preview was
// checked against the routes I happened to think of - /docs, /llms.txt - and not against the list of
// what `fetch()` actually handles. Derive the list, do not remember it.


async function versions(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(CACHE_KEY, request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const auth = (await settled(cwsToken(env))) || { token: null, why: 'threw' };
  const token = auth.token;
  const [crmCws, crmRepo, crmTag, anCws, anRepo, anTag, docsUpd, docsAnUpd] =
    await Promise.all([
      settled(cwsStatus(token, 'crm')), settled(repoVersion('crm')), settled(latestTag('crm')),
      settled(cwsStatus(token, 'analytics')), settled(repoVersion('analytics')),
      settled(latestTag('analytics')),
      settled(lastChanged('site/docs-crm.html')),
      settled(lastChanged('site/docs-analytics.html')),
    ]);
  const ok = (x) => (x && x.published !== undefined ? x : null);   // {http:403} is not a status
  const crmStore = ok(crmCws) && crmCws.published ? crmCws.published.version : null;
  const anStore = ok(anCws) && anCws.published ? anCws.published.version : null;
  const cwsWhy = auth.why !== 'ok' ? auth.why
    : (crmCws && crmCws.http) ? 'item-http-' + crmCws.http : 'ok';
  /* What is in review, and now with a *state* rather than an inference.
   *
   * This used to be the newest version RELEASES.md recorded as submitted, which answered the
   * question by proxy: a row I typed after clicking Submit. Google answers it directly, and answers
   * one thing the ledger never could — a submission that was **refused**. Without a state, a
   * rejected version is indistinguishable from one still queued, and the badge would have gone on
   * saying "awaiting review" for ever.
   *
   * It used to carry a date as well, read from RELEASES.md, because the API reports which state a
   * revision is in and never when it entered it. That is gone on the author's call: how many days a
   * package has been in the queue is not worth knowing, and it was the one figure here typed by hand
   * - so the badge now rests on Google alone and there is nothing left to keep in step. */
  const inReview = (cws) => {
    const s = ok(cws) && cws.submitted;
    if (!s || !s.version) return null;
    return { version: s.version, state: s.state };
  };

  // A source that failed is cached for a minute, not an hour. `settled()` turns a blip into null and
  // the page then says "unknown" — which is the honest word, and exactly the wrong thing to hold on to
  // for an hour after the source came back. This happened: one fetch to raw.githubusercontent failed,
  // and both submission dates read "unknown" long after the file was serving fine. Caching is there so
  // a blip is invisible; caching the blip itself is the opposite of that.
  /* When the site was last *published*, which is not when its source last changed.
   *
   * This was the newest commit touching `site/`, read from GitHub - and a commit is a proxy for a
   * deployment, not a deployment. They come apart exactly where this project has already been
   * burnt: with the build watch paths wrong, twenty-five builds ran for four site changes and then
   * stopped being queued at all, with no error on the push and the previous deploy left serving. The
   * badge would have dated the site by a commit nobody could see.
   *
   * The version metadata binding is the runtime's own answer - the creation time of the version
   * currently serving this request - so it needs no API token, no account id and no request that
   * could fail. Absent rather than guessed if the binding is not there: the badge says nothing
   * instead of dating the site by something else. */
  const updated = (env.CF_VERSION && env.CF_VERSION.timestamp) || null;

  const complete = [crmStore, crmRepo, crmTag, anStore, anRepo, anTag, updated].every((v) => v != null);
  const ttl = complete ? TTL : TTL_PARTIAL;

  const res = new Response(JSON.stringify({
    // `store`, `repo` and `tag` are kept alongside the per-product blocks so a page served from
    // cache before this shape existed still renders something true rather than nothing. `tag` is
    // deliberately CRM's rather than the old repo-wide value: an unqualified one was the bug.
    store: crmStore, repo: crmRepo, tag: crmTag,
    // The listing URL comes from here rather than being written again in site.js: the extension
    // ids already live in this file, and a second copy is a second thing to go stale.
    // `pending` is the whole answer about a submission: which version Google has, and in which
    // state. `cws` says whether that answer could be obtained at all - without it, "nothing is in
    // review" and "nobody could ask" look identical, and only one of them is a fact.
    crm: { store: crmStore, repo: crmRepo, tag: crmTag, pending: inReview(crmCws), url: listing('crm') },
    analytics: { store: anStore, repo: anRepo, tag: anTag, pending: inReview(anCws), url: listing('analytics') },
    cws: cwsWhy,
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
// The old path must never 404, and not merely for tidiness: **Zoost - workbench for Zoho CRM 1.9.0
// builds `zoost.it/docs.html`** — `const DOCS_URL = PRODUCT_URL + '/docs.html'` — and 1.9.0 is the
// version the Chrome Web Store is serving. A published extension cannot be asked to change, so the
// site keeps its side of that contract. Nothing in this repository links here any more, which is
// what makes it look removable and is exactly why it is not: the only thing pointing at it is an
// artefact nobody can edit. It becomes removable once no published version builds it and installs
// have had time to update — and even then it is four lines against a dead link that cannot be
// fixed. 301 rather than 302 so search engines move rather than keep asking.
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
    if (url.pathname === '/api/versions') return versions(request, env, ctx);
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
