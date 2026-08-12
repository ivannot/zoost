<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Nothing was cut: this is the same text,
     in the file CLAUDE.md now names. -->

# The release chain, in detail

**The Release title comes from the manifest, and two earlier versions of that line invented one
instead.** First it took the *directory* name and published "Zoost for crm 1.9.0". The fix for that
replaced the directory name with the platform's and left `Zoost for …` in place — the fourth form the
project explicitly bans — so "Zoost for Zoho CRM 1.11.0" went out on the most public surface there is.
`namecheck.py` had been reading `release.yml` the whole time and checked only whether the title used
the directory name: **it was checking the last bug rather than the rule**, which is the exact failure
this repository's checkers exist to stop. It now masks the legitimate forms and reports whatever is
left, the same technique `sitecheck.py` uses, and the workflow reads `name` out of `manifest.json` so
there is no second copy to keep in step.

**Every GitHub Action is pinned to a commit hash, never to `@v2`.** A tag is a ref its owner can
repoint at any time, so a supply chain that ends in "and then whatever that tag says today" is not
one. The trailing comment records which release each hash was, so an upgrade stays a deliberate edit.
Resolve one with `curl -s https://api.github.com/repos/<owner>/<repo>/git/ref/tags/<tag>` — and note
that an annotated tag answers with `"type":"tag"`, which must then be dereferenced to its commit;
pinning the tag object's own sha would not be a commit at all.

**An HTML comment inside a Markdown table ends the table.** `<!-- rows appended here -->` sat between
the header and the first row of `RELEASES.md`, so GitHub rendered an empty table followed by loose
pipe-delimited text — locally invisible, wrong on the only surface that matters. Instructions to a
future editor go *before* the header, with a blank line after them.

Tags are per product (`crm-v1.8.1`), and `RELEASES.md` is part of the release, not a follow-up.
If anything user-facing changed, regenerate `store/<app>/store-listing.md` and say which dashboard
fields move alongside the package — they are reviewed together.

**The upload is automated; the listing cannot be, and publishing is not, on purpose.**
`.github/workflows/store-upload.yml` runs itself when the release workflow finishes, downloads that
Release's asset, and puts it on the Store **as a draft** - `tools/cwsupload.py`, which reads the
publisher and the item ids out of `site/_worker.js` rather than keeping a second copy. It closes the
one gap `RELEASES.md` admits in writing: run from CI, the thing that uploads is the thing that built
and signed it.

**It was a by-hand step, and the argument for that was in the wrong place.** «Putting a package in
front of Google is a decision» is true of **Submit for review** - public, irreversible, and not called
from here at all. It is not true of staging a draft, which is reversible, invisible to users, refuses
over a review in progress and cannot touch the listing fields: once the tag exists there is no
judgement left in it, so by this project's own boundary - derivations automated, decisions not - it
belonged on the automated side the whole time.

**`workflow_run`, and not `on: release`, for a reason that would have been invisible.** The Release is
created by an action using `GITHUB_TOKEN`, and events raised by that token deliberately do not start
other workflows - so an `on: release` trigger here would have been a thing that never fires, with
nothing to distinguish it from one that had no work to do. It is the same shape as the tag gate that
refused every run: written, plausible, never exercised. The tag arrives as
`github.event.workflow_run.head_branch`, which is what GitHub puts there for a run started by a tag
push, and the download reads that rather than `inputs.tag` - which an automatic run does not have.

**And a review in progress is a skip, not a failure.** It is the normal state of the week after a
submission; painting it red on every release cut in that week would teach whoever sees it to ignore
this workflow, which is the one notification that must not be ignored. `--if-clear` says so and stops
at 0, and the by-hand dispatch is how the package gets staged once the review clears. Asked directly,
without that flag, it still refuses - a soft exit is by request, never a habit, the same shape as
`tools/totest.sh --auto`.

**Unproven end to end until the next release**, and said rather than assumed: `workflow_run` has never
fired here, because the trigger was added after the last tag. What has been checked is everything that
can be checked without cutting one - the YAML parses, the triggers are the two intended, the tag is
read from the field an automatic run actually has, and three cases hold the difference between the
automatic path and the by-hand one.

Three properties held by test, because each is one line away from being lost. **`:publish` appears in
nothing that can run on its own** - the token has the scope, so the only thing stopping it is that
nobody wrote it. **The upload refuses over a revision already in review**, which is the one state
nobody here has measured. And **the workflow has no `push:` or `release:` trigger**: building and
signing are derivations and happen on a tag; putting a package in front of Google is a decision.

What the API cannot do at all: the Store listing. Description, screenshots, permission justifications
and the privacy fields are dashboard-only, which Google's documentation states plainly - so somebody
opens it anyway, and that is the right moment to press Submit.

**Driving the dashboard with a browser script is refused, and it is the same rule as everywhere
else.** It would be synthetic clicks into a DOM this project does not own, against localized labels,
holding a path that can publish - three of the things the first non-negotiable names in one place. A
listing half-submitted by a script that met a changed page is worse than any amount of typing.

**What *is* derivable is which boxes to touch, and that is most of the tedium.** The pasting is not
the work; opening nine fields to find the two that moved is. `store/<app>/listing.json` records what
each section said when it was last submitted, so `python3 tools/storecopy.py <app> --changed` names
them - and `tools/shots.py` already says whether the five images still match the set on the listing.
Both are written by `tools/submitted.py`, in the one moment a person is confirming a submission
anyway.

**Publishing itself is not on this list, and is not yours to initiate.** Releases go to the Store in
batches, when there is something solid; cut a tag when asked, not when a version looks ready.

Pushing to `main` deploys `site/` to zoost.it: the Worker is connected to `ivannot/zoost` with root
directory `site`, production branch `main`, and `npx wrangler deploy` as the deploy command.

**Do not read "Source: Wrangler" in the deployment history as "deployed by hand".** Cloudflare's own
build runs that same command on its machine, so every deployment says Wrangler whether it came from a
push or from a laptop. Reading it as proof that Git was not connected cost a wrong diagnosis and a
wrong correction to this file.

**Build watch paths must be `site/*`, not `*`.** With `*` every commit to the repository starts a
build, including the twenty a day that only touch `apps/`. That burns the plan's build allowance on
nothing and, when it runs out, builds simply stop being queued — no error on the push, no banner, and
the last successful deploy left serving. It is what happened on 3 August: about twenty-five builds
for four site changes.

The deployment list only shows **successful** deploys. When a push does not appear there, the build
either did not run or failed, and only the **Builds** page says which — the deployment history cannot.

And the lesson that keeps being re-learnt: a push is not a publication until `curl` says so.
Documentation has to be correct at commit time, but it becomes visible only when a build succeeds.

The site is static plus one endpoint - `/api/versions`, answered by `site/_worker.js` - and the
footer shows whether four facts are in step, each from the source that actually holds it: what the
Chrome Web Store serves and what it has in the queue, from the Store API; the newest **tag** and the
`manifest.json` on `main`, from GitHub; and when the site went live, from the runtime. It reads tags
rather than GitHub Releases, because the routine above always creates a tag while attaching a Release
is a manual step that may not happen, and they are semver-sorted here rather than trusting the API's
unspecified order.

**«When the site was updated» is a deployment, and it was a commit.** `lastChanged('site')` reads the
newest commit touching `site/` - derived, nothing typed - but a commit is a *proxy*: it exists whether
or not a build ever ran, which is precisely the state this file records from 3 August, when the watch
paths were wrong, builds stopped being queued, and the previous deploy went on being served with no
error anywhere. On that day the badge would have dated the site by a commit nobody could read.
Cloudflare's REST API answers it - `GET /accounts/{id}/workers/scripts/{name}/deployments` carries
`created_on` - and costs an account-wide **Workers Scripts Read** token for a date in a footer. The
**version metadata binding** answers the same question from inside: `version_metadata` in
`wrangler.jsonc`, and `env.CF_VERSION.timestamp` is the creation time of the version serving the
request. No token, no account id, no request that can fail. Measured on a preview before it landed:
the commit was `07:53:23Z` and the value came back `07:53:48.4495Z` - twenty-five seconds later and
with sub-second precision, which the commits feed never has, so the two are telling apart rather than
being assumed to.

**The per-path dates stay on GitHub, and that is the opposite argument holding.** A guide must not
claim to have been updated because the homepage moved, which is exactly what a deployment date would
say. Site-wide: when did this go live. Per page: when did this content change. Different questions,
different sources, and neither answer is available from the other.

**A binding read but never declared is undefined for ever** - no error, no log, a footer that quietly
stops dating itself. `tests/tools_test.py` compares every `env.X` the Worker reads against what
`wrangler.jsonc` declares, with the secrets named separately because a secret must never be in a
committed config. It is also the reason the config must stay a **superset** of Cloudflare's generated
one: `version_metadata` is ours, added deliberately, and the generated file has no idea it exists.

**zoost.it is a Cloudflare *Worker* with static assets, not a Pages project.** Worker name
`zoost-it`, deploy `npx wrangler deploy`, root directory `site` — so `site/wrangler.jsonc` is the
config and every path in it is relative to `site/`. **`functions/` is a Pages-only convention** and
is never looked at here: a file placed there is published as a static asset (if inside `site/`) or
ignored entirely. Server-side code goes in `site/_worker.js`, which answers `/api/versions` and
hands everything else to `env.ASSETS`. Assets are served first and the script runs only when no file
matches, so adding to it cannot change how an existing page is served.

Two traps that this layout hides:

- **`site/.assetsignore` is what stops `_worker.js` and `wrangler.jsonc` being served as files.**
  The assets directory is `site/` itself, so anything in it is public by default — the generated
  config used to be readable at `/wrangler.jsonc`. Anything added beside the pages that is not meant
  to be downloaded must go in that ignore list.
- **Cloudflare generates a `wrangler.jsonc` when none is committed, and ours must stay a superset of
  it.** The generated one carries `compatibility_flags: ["nodejs_compat"]` and `observability`;
  committing a config without them would have silently changed the runtime. If the platform's
  defaults ever move, compare against what it generates before assuming ours is complete.

**A fact stated only at runtime is a fact half the readers never get.** `site.js` used to ship the
conservative wording in the markup - "submitted, in review", no install link - and hide it the moment
`/api/versions` reported a version scraped from the listing, so the page would be right the instant
the Store published without anyone editing it. It worked, in a browser. But the reader this site is
deliberately built for - an assistant handed the URL and asked to assess the product - **does not run
scripts**, and it read five surfaces saying Zoost Analytics was in review while three said it was on
the Store. It reported the contradiction, which is the failure: the site disagreeing with itself
about its own product. The promotion is gone, the markup states what is true, and
`published_state_is_stated()` in `auditcheck.py` holds every page against `/api/versions` in both
directions. A test asserts no page carries `data-pending` / `data-install` / `data-store` again,
because the mechanism is a fair-looking idea and the wrong shape for a fact somebody has to be able
to read without executing anything.

**`/emergency` is the page for the gap this chain cannot close: the review queue.** A tag is built,
signed and submitted within the hour; Google then takes days. When a fix for a break at Zoho's end is
sitting in that queue, the page shows what the Store is serving against what has been released, the
changelog of each version ahead, and a link to the archive **on the Release** - the attested one,
never a local build. It is fed by `/api/ahead`, which is separate from `/api/versions` on purpose:
the notes are kilobytes per version and every page's footer calls the other one, so the expensive
answer is fetched only where it is shown.

Three details worth keeping. *One*, the baseline decides the direction of a wrong answer: with no
Store version **or** no tag feed, `tagsAhead()` returns nothing and the page says «could not be
asked», because "you are up to date" told to somebody who is not sends them back to a broken
extension believing they checked. *Two*, the block is honest with no script - the markup points at
the releases page rather than claiming to be checking something. *Three*, the page states in its own
words that an unpacked build gets a **different extension id**, so it opens with empty settings while
the mirror on disk is untouched; that is the thing readers hit, and it looks exactly like the fix
having failed.

It is deliberately **not in the navigation**. It is reachable, quotable in an issue reply and linked
from `/nerd` and `/how-to`, but a first-time visitor should install from the Store, and a shortcut in
the header would say otherwise.

**The absolutes ledger listed words, and the strongest claim on the site is a noun phrase.** It
matched `mai`, `never`, `soltanto`, `only` - and never `read-only`, which is the one absolute this
project has already had to walk back. Two of them were live: an Italian hero reading «in sola lettura
su Zoho» and an Italian guide box promoting the English «only ever reads» to «è in sola lettura». Both
patterns are in `ABSOLUTE` now. The lesson is the one already here in another form - a checker built
from a list of *words* misses a claim made of two.

**A release gate for the outside view: `python3 tools/auditcheck.py`.** Three things, all mechanical:
**every file the site publishes** fetched from zoost.it and compared **byte for byte** against the
repository - and it means every file, which it did not until the icons were redrawn: it globbed
`.html` and `.txt`, so `site.css`, `site.js`, the sitemap, the web manifest and every icon were never
looked at, and it reported «what is served is what is in the repository» through a release that
replaced fourteen PNGs and rewrote two scripts. The exclusions come from `.assetsignore`, the same
list Cloudflare uses, rather than from a second copy kept in the tool; each store listing's §1 and §2 compared against the manifest's `name` and `description`;
and every **absolute claim** in outward prose listed *differentially* against `tools/absolutes.txt`, so
a new "never" or "only" has to be read once, deliberately, before it ships — printing all 354 every
run would be the checker nobody reads. `--accept` records them; `--offline` skips the network. Like
`reachcheck.sh` it is **not** in `tests/run.sh`: it needs the live site.

**A store listing is a working document, and the ledger used to read all of it.** These files wrap
the fields that get pasted into Google's dashboard in prose addressed to us: a paragraph naming which
checks read the file, a "Notes before submitting" list, and - the day this was found - a note saying
§9 has to be pasted again at the next submission. Read whole, those sentences land on a ledger of
**public claims**, and the note had to be reworded to avoid the word "every" so that a release gate
would go quiet. That is the tail wagging the dog: nothing we write to ourselves is a claim to anyone.

**The boundary is the numbered section, and "the fenced block" was the wrong answer by one section.**
Nine of them are a fenced block, which is what `storecopy.SECTION` copies to the clipboard one field
at a time - so reusing that pattern looks like the whole job. But `## 10. Data disclosures` is a
table and a blockquote rather than a paste field, because it is a set of dashboard checkboxes with a
justification under them, and that justification is where **"Nothing is sent to the developer"** and
**"the rows inside tables are never sent"** are promised. Reading fenced blocks alone would have
dropped the strongest claims in the file, in silence. `sitecheck` once made the mirror-image mistake
on these same files - it *stripped* the fences and passed on prose it had never read - so the rule is
now: everything under a `## <n>.` heading is outward, everything else in the file is ours. The fenced
body is preferred where there is one, and `storecopy.SECTION` is imported rather than restated.

**Narrowing a checker's input is the moment it can go quiet and call it clean.** Only *additions* are
reported, by design, so claims that disappear are invisible by construction: if a heading is
reformatted the pattern matches nothing, the listing contributes nothing, and the run says «0 new» -
the right answer to the wrong question. A listing that parses to no section is therefore a finding of
its own. The first version of that guard read `not lines` and would never have fired, because
splitting an empty string yields `['']`, a list of one; the test caught it, which is the argument for
writing the test before trusting the guard.

**The count moved from 915 to 909, and the six that left are all ours** - two file-title paragraphs,
"Before every resubmission: re-read §2…", two "Notes before submitting" bullets, and a note about
what the "WHAT IT DOES NOT DO" lines promise. Eight more were *re-keyed* rather than removed, which
exposed a second defect nobody had reported: a section's first sentence had its own heading and the
opening backticks glued to the front of it, because there is no full stop between them. So what the
ledger held was never the sentence as published, and renaming a heading - or changing a `max` - put a
real claim back on the ledger as unread. Both are fixed by the same change.

**It reads `site/it/` too, and the Italian words are in `ABSOLUTE` for the same reason the English
ones are** — «non scrive mai su Zoho» is exactly the sentence that fell to one POST, and a page
nobody's ledger reads is a page where an overstatement ships unread. It earned that immediately: the
Italian CRM page had translated the heading **"Read-first, on purpose"** as *«In sola lettura, per
scelta»* — promoting it to the absolute the English deliberately avoids, on a page whose whole
posture is that "read-only" has already had to be walked back once. Reviewing a translation is not
only asking whether it says the same thing; it is asking whether it says it **as weakly**.

The first section exists because a review opened by asserting that the homepage and `llms.txt` served
by zoost.it were still an earlier generation, "not a part: all of it". Five hashes refuted it in
thirty seconds. **Take an outside review as evidence, never as a verdict** — that same review was
exactly right about two smaller things, and both are fixed.

- **Reaching a site and being allowed to read it are different questions, and `reachcheck.sh` only
  asked the first.** Every probe returned 200 while Cloudflare's *managed robots.txt content* was
  injecting `Disallow: /` for **ClaudeBot, GPTBot, CCBot, Google-Extended, Applebot-Extended,
  Amazonbot, Bytespider and meta-externalagent**, above our own `Allow: /`. The door was open and the
  sign said keep out. Nothing in this repository could have caught it by reading the repository: it is
  an account setting, and `site/robots.txt` is correct. The practical effect is narrower than it looks
  — a user pasting the URL still gets a live fetch, which is the test this project is designed around
  — but AI *indexing* is refused, so an assistant that answers from an index has never seen the site.
  `reachcheck.sh` now parses robots.txt for the agents the strategy names.
- **And its HTTP probes prove less than they look.** They send a bot's user-agent string from an
  ordinary address; Cloudflare identifies a verified crawler by its **network**, not by that string, so
  a rule blocking ClaudeBot does not block the probe and the 200 is meaningless for it. The claim
  "every probe reached the site" was true and was being read as "every crawler can", which it never
  said. The script says so now. The authority is the toggle list in AI Crawl Control, which nothing
  here can read — so this is one of the few things that has to be looked at rather than checked.
- **An assessment measures what it could reach, and a 403 is invisible from a browser.** A review of
  this project concluded "still to be validated" while stating it had not managed to open the site —
  so its verdict measured its own reach rather than the product, and every "needs verifying" it
  listed was already answered on a page it never read. Cloudflare's default managed rules do 403 a
  couple of legacy scripted-client signatures (`Python-urllib`, `libwww-perl`); everything the
  strategy depends on — ClaudeBot, GPTBot, PerplexityBot, bingbot, Googlebot, curl, requests, no user
  agent at all — gets through, and `tools/reachcheck.sh` proves it rather than assuming it. Run it
  after any change to the Cloudflare configuration. It is **not** in `tests/run.sh`: it needs the
  network and the live site, and a suite that fails because DNS was slow is a suite nobody believes.
- **The Worker holds one credential, and its scope is the whole safety argument.**
  `CWS_SERVICE_ACCOUNT` is a Cloudflare **secret** holding the service account's JSON key, and the
  token it mints asks for `https://www.googleapis.com/auth/chromewebstore.readonly`, which is what
  this code requests and not a limit on the key - see the correction above. Setting it up has one step that is
  not in Google's documentation and cost an irreversible mistake: the field is on the **publisher's**
  account page, the one whose text says the service account «will be able to access all items through
  public APIs». It is **not** «Create a new publisher» on the developer profile page, which looks
  plausible, accepts the same email, and silently spends the one group publisher a developer account
  may ever create — the quota is not restored by deleting it. Google's own pages say only «add the
  required emails in the Developer Dashboard» and never describe the control.
  **Cloudflare has two boxes with nearly the same name, and the wrong one costs an afternoon.**
  The Worker's Settings page carries *Variables and secrets* twice: one under **Build**, described as
  "used during the build", and one at the top described as "used at runtime". Only the second reaches
  `env`. The value sat in the first for hours - present, visible, correct - while the Worker answered
  `no-credential` in preview and in production alike. **Read the description, not the heading.** The
  type must be **Secret** and not Json: the code does `JSON.parse` on it, so a Json binding would
  arrive already parsed and fail. And nothing about it goes in `wrangler.jsonc`, which the dashboard
  offers to update - that file is committed, so a secret in it is a published secret.
  A wrong guess about which box it was cost two false diagnoses here, both mine: first that plain-text
  vars do not survive `wrangler deploy`, then that preview versions do not inherit secrets. Neither
  was established, both were written down as if they were, and the user found the real cause by
  reading the sentence under the field.
  With the secret missing or the key revoked, `cwsToken()` returns null, every Store field is null and
  the badge says «unknown» — the fail-visible behaviour the rule above requires, rather than a stale
  number. `tools/whatsnew.py`-style raw material for a check does not exist here: the only way to
  prove this path is to run it, which `tests/` cannot do without the key, so it is exercised by hand
  against the live API and the parsing half (`pickStatus`) is what the suite covers.

- **Do not call `api.github.com` from the Worker.** It allows 60 unauthenticated requests an hour
  *per IP*, and the Worker leaves through Cloudflare's shared egress addresses, where that budget is
  already spent by strangers' traffic. Three of the badge's four fields came back null because of it,
  intermittently and with no error. The Atom feeds on `github.com` carry the same facts with no such
  limit and no credential: `tags.atom` for the newest tag, `commits/main/<path>.atom` for when a path
  last changed. They are XML, so parse shallowly and keep the shape guards.
- **Assets are served first, which means a handler for an existing file never runs.** The `.txt`
  charset fix sat in `_worker.js` for weeks as **dead code**: `/llms.txt` is a file, so Cloudflare
  answered it directly and the script was never asked. It took `assets.run_worker_first` to make it
  real. Worse than the bug is how it survived — it was reported, corrected, and **declared fixed on
  the wrong evidence**: the live bytes were compared against the repo and matched, which they always
  had. The bytes were never the problem. A rendering defect is verified by rendering it; the browser
  reported `document.characterSet === 'windows-1252'` and `â€”` on screen the whole time.
  `sitecheck.py` now derives the route list from the directory, so a new `.txt` cannot be forgotten.
- **A `.txt` has no way to declare its own encoding, so the header must.** Cloudflare serves plain
  text as `text/plain` with no charset; the browser then guesses, picks Windows-1252, and every
  em-dash in `llms.txt` arrived as `â€”`. The bytes were valid UTF-8 the whole time — HTML escapes
  this only because `<meta charset>` says it in-band. `_worker.js` sets the charset for any `.txt`,
  and a short `max-age` with it: the asset cache key ignores the query string, so a wrong response
  cannot be busted from outside and has to expire on its own. The fix deployed and the old header
  kept being served for as long as the default TTL allowed.
- **A query string cannot bust `/api/versions`, and that is the point of it.** Proposed as a way to
  refresh the footer quickly - and measured: `/api/versions` and `/api/versions?v=abcdef` come back
  with the same `checked` timestamp, because the cache key is built from `CACHE_KEY` and not from the
  request. It would bust the *browser's* copy and not the edge's, so right after a submission the
  reader still gets a payload up to an hour old, which is the case the idea was for. The two real
  levers are the ones already here: bump `CACHE_KEY`, or lower the TTL and pay for it in requests to
  Google.
- **The TTL is ten minutes, and the number came from counting.** It was an hour, which is the
  difference between submitting a version and seeing the footer say so. A miss costs **9 upstream
  requests** - 4 GitHub Atom feeds, 2 raw manifests, 2 `fetchStatus`, 1 token mint - so 600s is 54 an
  hour against 9, **per PoP**: Cloudflare caches per data centre, and the total is that times however
  many are warm, which is the term nobody here has a number for. Neither is Google's quota on the
  Store API, and those 2 of the 9 are what to watch if this is ever shortened again. `TTL_PARTIAL`
  stays at 60. **Changing it means bumping `CACHE_KEY`**: entries written under the old key carry the
  old `max-age` and would outlive the change by an hour - which is the second reason to bump it that
  this file already records, met for the first time.
- **The edge cache will hide your deploy.** `/api/versions` is cached for an hour and the Worker
  checks the cache before doing anything, so new code can run and still return the old body — no
  error, no 404, just a value that will not change. The key ignores the query string on purpose (so
  the cache cannot be flooded with junk keys), which means it cannot be busted from outside either.
  `CACHE_KEY` therefore carries a version marker: **bump it whenever the payload's shape changes, or
  the caching itself does**, or the change is invisible until the old entry happens to expire.
- **"Was this tag submitted" is not "is anything in review", and the footer answered the wrong one.**
  It read *Web Store 1.0.0 · latest release 1.11.0 not submitted yet* for Zoho CRM while 1.9.0 had been
  submitted the day before and was still being reviewed. Every word was true and the page was wrong,
  because the submission was looked up **by the newest tag** — so tagging something and not submitting
  it erases the release that is genuinely pending. Each product carries `pending` - the version Google
  reports as submitted, and its state - independent of what is tagged; the footer states it only when
  it adds a fact. Versions are compared **numerically**: 1.10.0 sorts before 1.9.0 as text.

  **And then the same defect arrived from the other side, with the API already in place.** The live
  footer read *latest release 1.39.0 not submitted yet* while `/api/versions` was reporting that exact
  version as `PENDING_REVIEW`. The state came from Google and the **date** from `RELEASES.md`, and the
  release line read the row alone: no row typed yet, so it announced the opposite of the one source
  that knows. The «in review» line was suppressed at the same moment, on the reasoning that the
  release line above already said it - two mechanisms each deferring to the other, and something false
  stated in the gap. **A hand-kept copy of a fact the platform reports can only ever fall behind it**,
  so the ledger is out of the badge entirely on the author's call: `pickSubmissions()`, the fetch of
  `RELEASES.md` and `submitted` in the payload are gone, and how many days a package has been in the
  queue is not worth knowing - «submitted» is. `RELEASES.md` keeps its dates as the human record of
  what was uploaded; nothing derives from them.

  What that costs is one state that has to be **admitted rather than guessed**: with no answer from
  the Store API, «nothing is in review» and «nobody could ask» look identical, so `releaseState()`
  takes `cws === 'ok'` and says nothing at all when it is not - «not submitted yet» would be inventing
  a measurement. It is a named function precisely so the tests can *run* it against the payload that
  produced the bug: every earlier check here read the source with a regex, and a regex agrees with the
  wrong version of this logic as readily as with the right one.
- **A failed source must not be cached for as long as a good answer.** One fetch to
  `raw.githubusercontent.com` timed out and both submission dates read "unknown" — correctly, and then
  **for an hour after the source had come back**, because the failure was stored under the same TTL as
  a complete reply. The point of caching here is that a blip is invisible; caching the blip is the
  opposite of that. `TTL_PARTIAL` is 60 seconds and applies whenever any source returned null, so an
  outage expires with the outage.

**The brand marks are inline SVG, and the platform's default caching was costing more than the
bytes.** Measured on the live site: three 192x192 PNGs downloaded on every page and drawn at 22-38px
- six times the pixels needed at dpr 2 - and **every asset served with
`cache-control: public, max-age=0, must-revalidate`**, which is Cloudflare's default and means a
revalidation round trip per file per page view. Inlining the marks costs **191 compressed bytes of
HTML** and removes three requests and 13KB: the page went from 6 requests and 26.1KB of resources to
3 and 7.0KB, and `load` from 386ms to 223ms. The geometry is copied from the shipped icon sources,
`apps/<app>/icons/icon.svg`. There used to be a `brand/` folder beside them holding the three-piece Z
this project retired, with a README stating a geometry - a 52x48 Z at 14px bar weight - that the
shipped mark had already stopped having. Deleted: a stale file that looks authoritative is worse than
a missing one, and nothing published ever read it.

`site/_headers` caches the images, the icon and the favicon for a week. **`site.css` and `site.js` are
deliberately not in it**: their names carry no hash, so a long cache would let a returning visitor
pair new HTML with an old stylesheet and see a broken page until it expired - that trade needs
versioned filenames first. Three things verified rather than assumed, because `functions/` had already
proved that a Pages convention is not a Workers one: `_headers` **is** read for Workers static assets;
it is consumed at deploy time and never served (it 404s); and it keeps working with `_headers` listed
in `.assetsignore` - which it must be, or `auditcheck` compares a file that has no URL. Nothing in it
reaches responses `_worker.js` generates, so `/api/versions` still sets its own.

Preview deploys are enabled for non-production branches, and the URL is
`<branch>-zoost-it.ivannot.workers.dev`. Anything touching the deployment goes there first and gets
verified with `curl` — endpoint status **and** the pages — before it reaches `main`.

And the lesson that cost two wrong guesses: **a successful deploy says nothing about an endpoint
being live.** Request it and read the status code —
`curl -s -o /dev/null -w '%{http_code}' https://zoost.it/api/versions` — and when something 404s,
find out *what the platform actually is* before moving files around.
