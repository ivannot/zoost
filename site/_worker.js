/*
 * zoost.it Worker. Everything is a static asset except two endpoints, which this script answers:
 * /api/versions, read by every page's footer badge, and /api/ahead, read only by /emergency.
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
 *  - Answers are cached at the edge for ten minutes, so a brief upstream failure is invisible.
 *
 * **This script holds no credential.** The Store figures were scraped off the listing page for
 * years, then read here from the Chrome Web Store API with a service-account key kept as a
 * Cloudflare Secret - which meant code answering public requests could read a key that can publish.
 * `tools/cwsscope.py` established that it can: the same key mints a token for the full
 * `chromewebstore` scope and the API answers. Read-only was a property of what this code asked for,
 * never of the credential, and Google links one service account per publisher with no narrower grant
 * on offer - so least privilege was not available here, and the key left instead.
 *
 * `tools/storestatus.py` now asks Google from a workflow and writes the answer to Workers KV, and
 * this reads it from there. What the API bought over the scrape is unchanged: «in review» is
 * Google saying so, and a **rejected** submission is expressible at all - without a state it would
 * be indistinguishable from one still in the queue.
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
// than guessed: a miss costs **5 upstream requests** (3 GitHub Atom feeds, 2 raw manifests), and
// «per PoP» is the term that matters, since Cloudflare caches per data centre and the total is that
// times however many are warm. It was 9 while this asked Google directly - two fetchStatus calls and
// a token mint - and those went away with the credential.
const TTL = 600;                        // seconds, when every source answered
const TTL_PARTIAL = 60;                 // …and when one did not, so an outage expires with the outage
const UA = 'zoost.it version badge (+https://zoost.it)';
const IS_VERSION = /^\d+(\.\d+){1,3}$/; // the shape guard: anything else is not a version

const timeout = (ms) => AbortSignal.timeout(ms);
const listing = (app) => `https://chromewebstore.google.com/detail/${EXT_ID[app]}`;

// Version ordering, in one place because two copies of it in one file would be two things to get
// wrong about the same question — and what they would disagree about is which release a reader is
// told to install. Descending, so a sorted list reads newest first.
//
// Lengths may differ: a tag is always `x.y.z`, but IS_VERSION accepts two to four components and the
// Store reports whatever it is serving. Missing components count as zero, which is what 1.9 vs
// 1.9.0 means to everyone except a comparator that indexes past the end and gets NaN.
// A function declaration rather than a `const` arrow, and not as a matter of taste: `tests/slice.mjs`
// lifts a declaration whole and cuts a multi-line `const` at the first semicolon that ends a line -
// which here is its first statement. The mis-slice is silent and the test then fails somewhere else
// entirely, which is how half an hour goes.
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}
const isNewer = (a, b) => cmpVer(a, b) < 0;   // spelt out: `cmpVer(a, b) < 0` reads backwards
// A declaration and not a `const` arrow, for the reason `cmpVer` gives four lines up: `slice.mjs`
// cuts a multi-line arrow at the first semicolon that ends a line, which here is its first
// statement - so this could not be lifted at all, and the copy of it in `site.js` was the only one
// any test ever ran. The two are character-identical today and nothing held them there.
function verOf(tag) {
  const m = /-v(\d+\.\d+\.\d+)$/.exec(tag || '');
  return m ? m[1] : null;
}

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
//
// The fetch is separate from the question asked of it: both products' tags are in the one document,
// so `/api/ahead` reads the feed once and asks it two things instead of fetching it twice.
async function tagsFeed() {
  const r = await fetch(`https://github.com/${REPO}/tags.atom`, {
    headers: { 'user-agent': UA, accept: 'application/atom+xml' },
    signal: timeout(6000),
  });
  if (!r.ok) return null;
  return r.text();
}

async function latestTag(app) {
  const xml = await tagsFeed();
  return xml ? pickLatestTag(xml, app) : null;
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
  const tags = [...xml.matchAll(re)].sort((a, b) => cmpVer(a[2], b[2]));
  return tags.length ? tags[0][1] : null;   // the tag name alone: it is what you check out
}

// Every released version **ahead of what the Store is serving**, newest first. The same feed and the
// same shape guard as above; what is new is the baseline it is measured against.
//
// The baseline is the whole point, and getting it wrong has a direction that matters. If the Store
// version could not be read, this returns nothing rather than every tag it can see: a list built
// without a baseline would tell a reader to go and install something over an installation that may
// already be newer, which is the one wrong answer this page must not give. "Unknown" is a state the
// page can render honestly; a confident wrong list is not.
//
// Capped, because the number of fetches downstream is one per entry. Five is well past the point
// where a reader is still reading, and it bounds a feed that grew unexpectedly.
export function tagsAhead(xml, app, from, cap = 5) {
  if (!from || !IS_VERSION.test(from)) return [];
  const re = new RegExp(`/releases/tag/(${app}-v(\\d+\\.\\d+\\.\\d+))(?:"|/|$)`, 'g');
  const seen = new Set();
  const out = [];
  for (const m of xml.matchAll(re)) {
    // Each entry names its tag more than once - the link and the id - and the same release must not
    // be offered twice.
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (isNewer(m[2], from)) out.push({ tag: m[1], version: m[2] });
  }
  return out.sort((a, b) => cmpVer(a.version, b.version)).slice(0, cap);
}

// What the Chrome Web Store says about our items, read out of KV rather than asked of Google here.
//
// It used to be asked from here, and that put a service-account key in Cloudflare as a Secret that
// request-handling code could read. The key can publish - `tools/cwsscope.py` mints a token for the
// full `chromewebstore` scope from it and the API answers - and Google links one service account per
// publisher with no narrower grant on offer, so read-only was a property of what this code asked for
// and never of the credential. Least privilege was not available where it was needed, so the key
// left: `tools/storestatus.py` runs in a workflow and puts the answer in KV, and this reads it.
//
// KV rather than a committed file, because a file under site/ is a build watch path: every Store
// change redeployed the site, and `siteUpdated` in the footer is that deploy's timestamp - so the
// site would have announced itself updated because a number at Google's end moved. It also lets
// `asOf` refresh on every run instead of only when the numbers move, which is what makes a workflow
// that quietly stopped visible at all.
//
// The reading carries `asOf`, and it is passed through rather than judged. A run that stopped
// happening leaves an old date on a true reading, and the page shows the date - which is this
// project's answer everywhere else: expose the number, let the reader weigh it. Inventing a
// staleness threshold here would be interpreting it, and would turn a working setup into «unknown»
// on a cron that ran late.
async function storeStatus(env) {
  try {
    const d = env.STATUS ? await env.STATUS.get('status', { type: 'json' }) : null;
    if (!d) return { crm: null, analytics: null, cws: 'no-file', asOf: null };
    return { crm: d.crm || null, analytics: d.analytics || null,
             cws: d.cws || 'ok', asOf: d.asOf || null };
  } catch {
    // Same shape either way, so «nobody could ask» stays one thing the pages already know how to say.
    return { crm: null, analytics: null, cws: 'unreadable', asOf: null };
  }
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

// What changed in a released version, read from the file the Release body was built from.
//
// `store/<app>/whatsnew/<version>.md` rather than the Release body itself: the body is the notes
// followed by a provenance block addressed to somebody verifying a hash, and a reader deciding
// whether a fix is worth the trouble wants the first half only. It is also one raw file instead of
// api.github.com, which is the rate limit this Worker already goes out of its way to avoid.
//
// The version is interpolated into a path, so it is checked against the shape guard first even
// though every caller here takes it from a tag that already matched `\d+\.\d+\.\d+`. The guard costs
// nothing and the assumption it protects is one refactor away from stopping being true.
//
// It answers «here they are», «there are none» and «I could not find out» as three different things,
// and that is the whole of this function's shape. It used to answer the last two identically - null
// for a 404 and null for a 502 - and the page then stated «No notes were published for this
// version» over a request that had simply failed. That is the defect this product already fixed one
// system over, in the Analytics panel, where a query table whose SQL could not be fetched was
// reported as not being a query table: **«not read» must never masquerade as «does not exist»**. It
// matters more here than it did there, because /emergency exists to help somebody decide whether a
// version is worth installing by hand, and an empty changelog is an argument against bothering.
async function whatsnew(app, version) {
  // A programmer error rather than a state of the world, so it throws and reads as unreadable: a
  // caller passing a version that is not one has not established that there are no notes.
  if (!EXT_ID[app] || !IS_VERSION.test(version)) throw new Error('whatsnew: bad app or version');
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/store/${app}/whatsnew/${version}.md`,
    { headers: { 'user-agent': UA }, signal: timeout(6000) });
  // 404 is the one answer that means it: a version from before the convention has no file. Anything
  // else - 5xx, a rate limit, a network fault - is GitHub declining to say, and saying so is the
  // only honest thing left.
  if (r.status === 404) return { none: true };
  if (!r.ok) throw new Error(`whatsnew: ${r.status}`);
  const t = (await r.text()).trim();
  // A size guard, so a surprise file cannot blow the payload. An empty file is «none»: there is
  // nothing to show and nothing failed.
  return t ? { text: t.slice(0, 8000) } : { none: true };
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
const CACHE_KEY = '/api/versions?v=21';  // bumped: the payload gained storeAsOf when the credential left
// (v=21 stands: what the endpoint fetches changed, the payload it answers with did not.)

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

  // The feed is fetched **once** and asked two things. It used to be `latestTag('crm')` and
  // `latestTag('analytics')`, each fetching the same `tags.atom` - the discipline `tagsFeed` was
  // split out for, written down in its own comment, and applied to `/api/ahead` while this endpoint,
  // the one every page's footer calls, went on paying for the document twice. One of a pair changed
  // and the other left behind, in the copy that carries all the traffic.
  const [store, crmRepo, anRepo, xml, docsUpd, docsAnUpd] =
    await Promise.all([
      settled(storeStatus(env)),
      settled(repoVersion('crm')), settled(repoVersion('analytics')),
      settled(tagsFeed()),
      settled(lastChanged('site/docs-crm.html')),
      settled(lastChanged('site/docs-analytics.html')),
    ]);
  const crmTag = xml ? pickLatestTag(xml, 'crm') : null;
  const anTag = xml ? pickLatestTag(xml, 'analytics') : null;
  const s = store || { crm: null, analytics: null, cws: 'unreadable', asOf: null };
  const crmCws = s.crm, anCws = s.analytics;
  const crmStore = crmCws && crmCws.published ? crmCws.published.version : null;
  const anStore = anCws && anCws.published ? anCws.published.version : null;
  const cwsWhy = s.cws;
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
    const sub = cws && cws.submitted;
    if (!sub || !sub.version) return null;
    return { version: sub.version, state: sub.state };
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

  // Complete means **every source answered**, not «every value is present». Those came apart the day
  // both listings were unpublished for a resubmission: `cws` said `ok`, the reading was twenty
  // minutes old and correct, and both `store` fields were null - because Google has no published
  // version to report, which is a fact and not an outage. Judged by the values, that read as partial
  // and the endpoint every footer on the site calls dropped to the sixty-second TTL for as long as
  // the listings stayed down: ten times the upstream cost, over nothing being wrong.
  //
  // It is this file's own rule, held two tests over for the *wording* and never applied to the
  // decision - a 404 is «there are none» and anything else is «I could not find out». `cwsWhy` is
  // exactly that signal for the Store half, so it is what gets asked.
  const complete = cwsWhy === 'ok' && [crmRepo, crmTag, anRepo, anTag, updated].every((v) => v != null);
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
    // When the Store was last actually asked. Passed through rather than judged: an old date on a
    // true reading is a fact the reader can weigh, and a threshold invented here would turn a cron
    // that ran late into «unknown».
    storeAsOf: s.asOf,
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

// What is released but not yet on the Store, and what changed in it.
//
// This answers one page - `/emergency` - and it is deliberately not folded into `/api/versions`.
// That endpoint is called by the footer badge of **every** page, and the notes are a few kilobytes
// per version: putting them there would make every visitor download a changelog nobody asked to
// read. Two endpoints, two cache entries, and the expensive one is fetched only where it is shown.
//
// What it is careful about is the direction of a wrong answer. Telling somebody "you are up to date"
// when they are not costs them a bug they could have escaped; telling them "there is a newer one"
// when there is not sends them to install an older build over a newer one by hand. So a Store
// version that could not be read yields an empty list and a `cws` field saying why, and the page
// renders that as «nobody could ask» rather than as either answer.
const AHEAD_KEY = '/api/ahead?v=3';  // bumped: each ahead entry gained notesWhy

async function ahead(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(AHEAD_KEY, request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const [store, xml] = await Promise.all([settled(storeStatus(env)), settled(tagsFeed())]);
  const s = store || { crm: null, analytics: null, cws: 'unreadable', asOf: null };

  const block = async (app) => {
    const c = s[app];
    const store = c && c.published ? c.published.version : null;
    const list = xml ? tagsAhead(xml, app, store) : [];
    const notes = await Promise.all(list.map((t) => settled(whatsnew(app, t.version))));
    return {
      store,
      latest: xml ? verOf(pickLatestTag(xml, app)) : null,
      // The same shape `/api/versions` uses, so a reader of one file is not learning two vocabularies
      // for the same fact.
      pending: c && c.submitted && c.submitted.version
        ? { version: c.submitted.version, state: c.submitted.state } : null,
      ahead: list.map((t, i) => ({
        version: t.version,
        tag: t.tag,
        // Built rather than looked up: this is the name `build.sh` gives the archive and the name the
        // release workflow uploads, and it is the file the attestation was signed over. A second
        // request to find out a URL we already know would be a second thing to fail.
        zip: `https://github.com/${REPO}/releases/download/${t.tag}/zoost-${app}-${t.version}-store.zip`,
        notes: notes[i] && notes[i].text ? notes[i].text : null,
        // Which of the two absences this is. `settled()` turns a throw into null, so null here is
        // «could not find out» and `{none:true}` is «there are none» - the page says a different
        // sentence for each, and the cache below holds only the first one briefly.
        notesWhy: notes[i] ? (notes[i].text ? 'ok' : 'none') : 'unreadable',
      })),
      url: listing(app),
    };
  };

  const [crm, analytics] = await Promise.all([block('crm'), block('analytics')]);

  // A note that failed to fetch is cached for a minute, not an hour: an empty changelog beside a
  // version somebody is deciding about is exactly the answer not worth holding on to. It used to be
  // «absent», which could not tell that from a version released before the convention - so every
  // such version pinned this endpoint to the short TTL for ever, over nothing that would ever
  // change. Now the two are distinguishable and only the failure is treated as one.
  const gaps = [crm, analytics].some((b) => b.ahead.some((a) => a.notesWhy === 'unreadable'));
  // Whether every **source answered**, never whether every value is present - the same question
  // `/api/versions` asks three hundred lines up, and for the same reason. This read
  // `crm.store != null && analytics.store != null`, so a product mid-republication - which has
  // `store: null`, a fact Google gave us - pinned the endpoint to the short TTL for the whole of
  // a review. Measured live at `max-age=60` with `cws: ok` and nothing wrong, on the endpoint
  // that costs the most to build: the Store, the tag feed, and a release note per version ahead.
  // The fix had already been made next door and had not travelled here.
  const complete = s.cws === 'ok' && xml != null && !gaps;

  const res = new Response(JSON.stringify({
    crm,
    analytics,
    // Without this, "nothing is ahead" and "nobody could ask the Store" are the same empty list, and
    // only one of them is a fact. Same field, same meaning, as `/api/versions`.
    cws: s.cws,
    storeAsOf: s.asOf,
    checked: new Date().toISOString(),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${complete ? TTL : TTL_PARTIAL}`,
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
// ---------------------------------------------------------------------------------------------
// /api/report - the one endpoint on this site that *writes* anywhere.
//
// It turns a report the reader has already seen twice into a public issue on the Zoost repository.
// Everything about it is built on the assumption that whoever calls it is hostile: the address is in
// the extension's source, so it is public, and what it does is post under the maintainer's name.
//
// The rules, in the order they are applied:
//   1. POST, same-origin, JSON, or nothing happens.
//   2. It refuses unless BOTH secrets are configured. A write path to a public repository with its
//      captcha switched off is worse than a missing feature - so «not configured» fails closed.
//   3. Turnstile must pass. It is the only thing standing between this and a script.
//   4. Rate limited per IP, by a salted hash: this endpoint never stores or logs an address.
//   5. Size caps, and the text must look like something a Zoost panel produced.
//   6. Redacted **again**, here. The panel already did it; a client is never believed twice.
//   7. The issue body is *rebuilt* from validated pieces and fenced. Nothing is passed through.
const REPORT_REPO = 'ivannot/zoost';
const REPORT_MAX = 8000;          // a panel report is 2-6 KB; past this it is not one
const REPORT_SAYS_MAX = 2000;
const REPORT_PER_IP_PER_DAY = 5;

// The same rules as the panel's own redact(), applied to text this Worker did not build. Kept as a
// separate copy on purpose: shared code between a client and the thing that distrusts it is a way
// for one edit to switch off both. tests/tools_test.py holds the two to the same behaviour.
function reportRedact(text) {
  return String(text == null ? '' : text)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<email>')
    .replace(/https?:\/\/[^\s)"']+/gi, '<url>')
    .replace(/\b\d{8,}\b/g, '<id>')
    .replace(/«[^»]*»/g, '«…»')
    .replace(/"[^"]*"/g, '"…"');
}

// A fence the content cannot climb out of: every backtick run in the text is defanged, and the
// fence itself is longer than anything left. Without this a report containing ``` would end the
// block and the rest would be rendered as markdown - which is how a link, an image or an HTML
// comment gets into an issue nobody wrote.
function reportFence(text) {
  return '```\n' + String(text).replace(/`/g, 'ˋ') + '\n```';
}

async function reportRateKey(env, ip) {
  // Salted with a secret, so the stored key cannot be walked back to an address even by whoever
  // reads the KV. No address is written anywhere, and nothing here is logged.
  const data = new TextEncoder().encode(String(ip) + '|' + (env.REPORT_SALT || env.TURNSTILE_SECRET || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return 'rl:report:' + [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function report(request, env) {
  const bad = (status, error) => new Response(JSON.stringify({ error }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  if (request.method !== 'POST') return bad(405, 'Use POST.');
  // `new URL('null')` throws, and a sandboxed iframe or a hand-made request sends exactly that -
  // which turned a 403 into an unhandled exception and a platform error page.
  // A browser sends `origin` on a cross-site POST, so this stops a form on someone else's page. A
  // client that simply omits the header is *not* refused here, and the honest reason is that this
  // endpoint has no cookie and no session: there is nothing for a forged cross-site request to spend,
  // and the gate that matters is Turnstile below. Said plainly because the shape of the check reads
  // as more than it does - raised by an outside review, and right about the reading.
  const origin = request.headers.get('origin') || '';
  if (origin) {
    let host = null;
    try { host = new URL(origin).hostname; } catch (_) { return bad(403, 'Wrong origin.'); }
    if (host !== new URL(request.url).hostname) return bad(403, 'Wrong origin.');
  }
  // Fails closed. A missing secret is a misconfiguration, and the safe reading of a misconfigured
  // write path is «refuse», not «accept without the check».
  if (!env.TURNSTILE_SECRET || !env.GH_TOKEN) {
    return bad(503, 'Reporting is not configured on this server. Please open an issue by hand, or email ivan@zoost.it.');
  }

  let body;
  try { body = await request.json(); } catch (_) { return bad(400, 'Malformed request.'); }
  const text = String((body && body.report) || '');
  const says = String((body && body.says) || '').slice(0, REPORT_SAYS_MAX);
  const token = String((body && body.token) || '');
  // The page reports whether the reader unlocked and changed the trace. A client could lie about it,
  // and that is not the case this defends against: it tells an honest sender's reviewer that the
  // text in front of them is no longer what the browser produced.
  const edited = (body && body.edited) === true;
  // A report written on the page by somebody with no panel in front of them - somebody without a
  // GitHub account, which is the whole reason this path exists. It carries no trace, so it is
  // labelled and titled as what it is: nobody should read a description as evidence.
  const hand = (body && body.hand) === true;
  if (!text.trim()) return bad(400, 'There is nothing to send.');
  if (hand && !says.trim()) return bad(400, 'There is nothing to send.');
  if (text.length > REPORT_MAX) return bad(413, 'That is larger than a panel report - please open an issue by hand.');
  // It has to look like what the panel writes. This is not a security boundary; it stops the
  // endpoint being a general-purpose way to post anything at all to the repository.
  if (!/^Zoost /.test(text.trim())) return bad(400, 'That does not look like a Zoost report.');

  const ip = request.headers.get('cf-connecting-ip') || '';

  // **Turnstile first, and the counter after it.** The order used to be the other way round, and it
  // cost the reader the thing this endpoint is for: a token is single-use and expires, and this page
  // asks you to *read* the report before sending it - so a token that has gone stale answers «the
  // check did not pass, please try again», the widget resets, and five presses of Send later a person
  // who has published nothing is refused for 24 hours. Reported by an outside review, which also
  // pointed out that this repository already holds the rule one case over: a test requires the
  // empty-report check to run before the limiter, because otherwise it spends a slot of the daily
  // limit. The check that refuses most hostile traffic was the one it was never applied to.
  //
  // The other half is cheaper and just as real: before this, an unauthenticated caller who cannot
  // pass the challenge still caused five KV writes per address, in a namespace shared with the
  // workflow that keeps /api/versions truthful.
  const ok = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  }).then((r) => r.json()).catch(() => null);
  // The hostname too: a token is minted for a site key, and if that key's allowed-domain list is
  // ever widened - a preview deployment, a second site - a token minted elsewhere would otherwise
  // be accepted here. Checking it costs one comparison and keeps the widening honest.
  if (!ok || !ok.success) return bad(403, 'The check did not pass. Please try again.');
  if (ok.hostname && ok.hostname !== new URL(request.url).hostname) return bad(403, 'The check did not pass. Please try again.');

  const key = await reportRateKey(env, ip);
  // Fails closed. The first version swallowed a KV error into `seen = 0`, so an outage of the store
  // switched the limit off entirely - a rate limit that disappears exactly when things are going
  // wrong is not one. Refusing costs a reader a message that names the other two ways in.
  let seen = 0;
  try { seen = Number(await env.STATUS.get(key, { cacheTtl: 60 })) || 0; }
  catch (_) { return bad(503, 'The limiter is unavailable, so nothing is being accepted right now. Please open an issue by hand, or email ivan@zoost.it.'); }
  if (seen >= REPORT_PER_IP_PER_DAY) return bad(429, 'That is several reports from here today. Please open an issue by hand, or email ivan@zoost.it.');
  // Counted **before** the issue is created, not after. Counting afterwards let concurrent requests
  // all read the same number and all go through.
  //
  // What this is *not*: a lock. KV is eventually consistent and the read is cached at the edge, so
  // requests arriving together can read the same number and all pass - the width of that window is
  // the cache, not one request. The comment here used to claim «not one race wide», which overstated
  // it; what bounds a burst is the cost of minting Turnstile tokens, and that is now the check
  // *above* this one rather than below it. Said precisely because an overstated guarantee is the kind
  // of sentence this project has had to walk back before.
  //
  // Fails closed, like the read above and for the same reason. This was `catch (_) {}`: a KV fault
  // that stopped `put` while `get` kept answering would return 0 for ever, and the five-a-day ceiling
  // would stop existing **in silence** - on the one endpoint here that opens public issues under the
  // maintainer's token.
  //
  // It is also a defect this repository has already named once, in `updateMetaIndex`: a refused write
  // swallowed by `.catch(() => {})`, so the caller went on to clear its dirty mark over a write that
  // never happened. Same shape, one system over. Found by an outside review.
  try { await env.STATUS.put(key, String(seen + 1), { expirationTtl: 86400 }); }
  catch (_) { return bad(503, 'The limiter is unavailable, so nothing is being accepted right now. Please open an issue by hand, or email ivan@zoost.it.'); }

  // Rebuilt, never passed through: two fenced blocks and a sentence saying where they came from.
  const clean = reportRedact(text);
  const extra = reportRedact(says);
  // Held to a plain charset: the title is the one part not inside a fence, and it lands in the
  // maintainer's notification email. Nothing here can carry markup, a link, or a control character.
  const first = clean.split('\n')[0].slice(0, 80).replace(/[^\w .,:·+()\/-]/g, ' ').replace(/\s+/g, ' ').trim();
  // A hand-written report's first line is a fixed header, so titling from it would name every one
  // of them identically. What it is about is in the notes, which is where the title comes from.
  const handFirst = extra.split('\n')[0].slice(0, 80).replace(/[^\w .,:·+()\/-]/g, ' ').replace(/\s+/g, ' ').trim();
  const issue = {
    title: hand
      ? 'Written by hand: ' + (handFirst || 'a problem')
      : (edited ? 'Panel report (altered): ' : 'Panel report: ') + (first || 'a problem'),
    body: [
      hand
        ? '**Written by hand on zoost.it, with no panel and no trace.** Nothing here was produced by a '
          + 'browser: it is a description, and everything a trace would have said has to be asked for.'
        : edited
          ? '**The sender edited this trace before sending it.** It is no longer what the browser produced, '
            + 'so treat it as a description rather than as evidence - lines may be missing or changed.'
          : 'Sent from a Zoost panel by a user who read it first. Redacted by the panel and again here.',
      '',
      hand ? reportFence(extra) : reportFence(clean),
      !hand && extra.trim() ? '\n**What they were doing**\n\n' + reportFence(extra) : '',
    ].join('\n'),
    labels: hand ? ['from-page'] : edited ? ['from-panel', 'altered-trace'] : ['from-panel'],
  };
  const made = await fetch(`https://api.github.com/repos/${REPORT_REPO}/issues`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.GH_TOKEN,
      accept: 'application/vnd.github+json',
      'user-agent': 'zoost-report-worker',
      'content-type': 'application/json',
    },
    body: JSON.stringify(issue),
  }).then((r) => r.json()).catch(() => null);
  if (!made || !made.html_url) return bad(502, 'GitHub refused it. Please open an issue by hand, or email ivan@zoost.it.');

  return new Response(JSON.stringify({ url: made.html_url }), {
    status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const MOVED = {
  '/docs': '/docs-crm',
  '/docs.html': '/docs-crm',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/versions') return versions(request, env, ctx);
    if (url.pathname === '/api/ahead') return ahead(request, env, ctx);
    if (url.pathname === '/api/report') return report(request, env);
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
