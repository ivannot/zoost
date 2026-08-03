# CLAUDE.md

Working notes for this repository. Conventions, decisions already taken, and traps already hit.
Read this before changing anything.

---

## What Zoost is

A Chrome MV3 extension that mirrors a Zoho CRM org — Deluge functions, module schema, layouts,
related lists, workflows, schedules — into plain local files, and layers navigation, diagrams,
search, audit and export on top of that mirror.

It is **read-only towards Zoho**. It never writes back, and never touches CRM records.

## Repository layout

```
src/      the extension. Exactly what ships. Nothing else lives here.
site/     zoost.it — deployed automatically by Cloudflare on push to main
site/functions/  Cloudflare Pages Functions (server-side, edge). `site/functions/api/x.js` → /api/x
store/    Chrome Web Store listing copy and permission justifications
dist/     build output, git-ignored
```

`LICENSE`, `NOTICE` and `README.md` live at the root so GitHub picks them up; `build.sh` copies
the first two into the package at build time.

## Build

```bash
./build.sh              # dist/zoost-<v>-store.zip     manifest at archive ROOT — for the Web Store
./build.sh --unpacked   # dist/zoost-<v>-unpacked.zip  folder-wrapped — for Load unpacked
```

Getting these the wrong way round wastes half an hour: the Web Store rejects a zip whose manifest
is inside a folder, and `chrome://extensions` wants the folder.

## Non-negotiables

- **No write path to Zoho.** Zoho compiles and validates server-side. A write path means owning
  deployment, conflicts and rollback — a different product.
- **No dependencies, no build step, no framework.** Plain JavaScript. The extension ships as
  readable source and must stay auditable by anyone about to give it access to their CRM.
- **No new `manifest.json` permissions** without discussing it first. Every one has to be
  justified to the Web Store and to users, and the justification text lives in `store/`.
- **Never ship a claim that has not been tested.** Only Anthropic and OpenAI are supported as AI
  engines, because those are the two that are tested and the only two the manifest grants network
  access to. An untested feature is worse than a missing one.
- **Never add data fetching without the UI that shows it**, and never add UI for data that is not
  fetched. Dead code in either direction is not acceptable.
- **No legacy fallbacks left lying around.** When something is renamed or replaced, the old path
  goes. Migration code is written to delete itself.
- **Do what you're certain of, or stop — never click-and-hope.** No retry loops against an
  assumption, no matching Zoho's *localized* UI text, no synthetic clicks into a DOM contract we
  do not own. Reach Zoho by constructed URL and read it through the API; if a certain path does not
  exist, the feature stops with a precise message instead of guessing. This is why the function
  "Go to" (which drove the Zoho editor via synthetic clicks on a localized "Edit function" label,
  and looped ten times before failing with a wrong message) was removed in 1.1.0. "Find" navigates
  to the functions list and filters it deterministically — the last, language-dependent click is
  the user's. Legitimate exceptions the rule still allows: a *bounded* wait for a known element to
  appear after a navigation, recovering by a known action (re-injecting the bridge), handling known
  API variants (OpenAI `max_tokens` vs `max_completion_tokens`), and one retry on a genuinely
  transient failure (network, 429, 5xx) — never on a deterministic 4xx.

  **This rule binds the extension absolutely; the website is judged differently.** The extension is
  where work happens: someone acts on what it says, so an uncertain answer there can cost real time
  or real data. `zoost.it` is informational — if a scraped number goes missing the page says
  "unknown" and nobody is harmed. So the site may depend on a source we do not control (the version
  badge reads the Chrome Web Store listing's markup, since Google publishes no API), provided the
  dependency **fails visibly and cannot lie**: validate the shape of what came back, discard anything
  that does not match, show "unknown" rather than a stale or guessed value, and cache so a blip is
  invisible. Never carry this licence back into `src/`.

## Architectural decisions worth not re-litigating

**Workspace identity is the org id inside `.zoost.json`, never the folder name.** One working
folder holds a subfolder per org, named `instance[-sandbox]-orgid`. That name is a label:
renaming the folder, or renaming the Zoho portal, must not orphan a workspace. The workspace list
is built by enumerating the root and reading each config.

**The environment guard is the most important safety property.** Each workspace is bound to one
org, host and instance. If the active Zoho tab belongs to a different org, every Zoho-bound action
is disabled. Do not weaken this for convenience.

**Layout, relation and schema data come from the pull, not from live calls.** The graph window
reads what was written to disk. If a feature needs data that is not in the module JSON, the pull
has to be extended and the user has to re-pull — say so in the UI rather than failing silently.

**Function meta carries a schema version (`sv`), and old copies backfill themselves.** When the pull
starts capturing a new field (e.g. `connections`, `modified_by` in 1.2.0), bump `sv` in
`content-bridge.js` `toFile()` and in `META_SV` in `sidepanel.js`. Functions on disk below `META_SV`
render as **stale** (amber ◐ dot) and are folded into the "Complete missing / Refresh outdated"
flow, so existing workspaces top up the new fields with one click instead of a full re-download.
This is how you evolve the captured data without orphaning already-pulled workspaces.

**Related-list API names are a first-class concept.** The API name of a related list is neither
module's `api_name`, and it is what `zoho.crm.getRelatedRecords()` requires. This is the single
most valuable thing the tool surfaces; treat it accordingly.

**The ER diagram has two layout branches**, and they are mutually exclusive:
concentric (focus + ego set) driven by `ring`, and force-directed driven by `spread`.
A control that does nothing in the active branch must be hidden, not shown and ignored.

**Readability trade-offs are exposed, not guessed.** Diagram spacing, spread and label size are
runtime sliders, because there is no single right value across graphs.

**AI configuration lives in the options page**, not the side panel. The panel is ~400px wide and
those are set-once fields. The panel picks changes up via `chrome.storage.onChanged` plus a
`window.focus` re-read. A selector that changes a *mode* saves on change, not behind a Save button.

## Traps already hit — check for these

These all failed **silently**, with no console error. They are the expensive kind.

- **JS escapes inside HTML text.** `\u2699` written into markup renders as the literal string.
  HTML does not interpret JavaScript escapes. Use the character, or an HTML entity.
- **`esc()` is not attribute-safe.** It escapes `& < >` only. A double quote inside an attribute
  closes it early and truncates the value — this is what cut the `getRelatedRecords` snippet in
  half. Use `escA()` in attribute contexts.
- **CSS specificity and source order.** `.erbox.dim .erhdr` placed before `.erbox.custom .erhdr`
  loses at equal specificity. Muting rules must come after the rules they override.
- **Sticky headers need a z-index.** Without one, later siblings paint over them and rows appear
  to slide above the header.
- **Overlays sized to the wrong container.** `inset:0` covers the positioned ancestor, not the
  panel. Check what actually needs covering before choosing `absolute` or `fixed`.
- **Functions that rewrite state as a side effect.** `cacheBinding` writing `.zoost.json` would
  have clobbered `lastPull`, because it carries fewer fields than the file holds.
- **OpenAI model compatibility.** Newer models reject `max_tokens` and require
  `max_completion_tokens`. The call tries the first and retries on that specific 400.
- **Stripping comments and strings from Deluge cannot be done with chained regexes.** Removing line
  comments before string literals cuts `url: "https://x"` at the `//`, which leaves an unterminated
  quote that swallows the following lines — the counts then silently under-report. `stripNonCode()`
  is a single left-to-right scan for exactly this reason. A unit check caught it; the eye did not.
- **`/deluge/` endpoints want a different CSRF prefix than `/crm/`.** The `/crm/...` APIs take the
  CSRF token as `crmcsrfparam=<token>`; the `/deluge/` (deluge runtime) APIs take the *same* token
  value as `drepn=<token>`. Wrong prefix → **400, not 401**, so it reads as a bad request, not an
  auth failure — misleading. `api(path, csrfPrefix)` in `content-bridge.js` carries the prefix; the
  connections catalogue (`/deluge/api/ui/v1/{org}/services/ZohoCRM/connections`) uses `drepn`, and
  needs the `zuid` (scraped from the page like the org id).

The pattern behind most of these: a value crossing a boundary — between languages, between
contexts, between code branches — and being interpreted differently on the other side. Those are
the places to look first when something "does nothing".

## Naming and positioning

The product is **Zoost — workbench for Zoho CRM**. Not "IDE": you do not edit code in it, and the
audience is wider than developers. "Zoho", "Zoho CRM" and "Deluge" appear only in a descriptive
position, never as the leading element of the name, and never in the icon. Every user-facing
surface carries the independent/unofficial disclaimer.

The name comes from `chrome.runtime.getManifest().name` everywhere. Renaming means editing one
field in `manifest.json`.

## Definition of done

A change is not finished when the code works. It is finished when everything that describes the
code has caught up with it. **Do this without being asked** — never wait for me to request a
documentation update or a build.

### Documentation must follow the code, in the same change

When behaviour, UI or features change, check every one of these and update what is stale:

| File | Update when |
|---|---|
| `README.md` | features, interface, quick start, known limitations |
| `site/docs.html` | anything a user does differently — **and the "Covers Zoost X.Y" line at the top, always** |
| `site/index.html` | a feature worth advertising appears or changes |
| `site/privacy.html` | what data is stored, or where it travels, changes at all |
| `store/store-listing.md` | description, single purpose, or any permission justification |
| `CLAUDE.md` | a new convention, decision or trap that the next session must know |

Two rules that are not optional. **Never let a claim outlive its truth**: today the store
description still said the extension "never sends your code anywhere", which the AI assistant made
false. And **never describe a feature that is not tested** — the OpenAI-compatible endpoint claim
was written before anyone had tried it, and had to be walked back everywhere.

A third, just as binding. **Declare only what we have; have everything we declare — on every surface,
on adding *and* on removing.** This is not tidiness, it is the product's claim to being correct and
transparent. Catching it is **your** job, never the user's.

Mentioning a feature once is not enough, and it is the trap that has actually been hit here twice.
Every surface enumerates the product's parts in several places — a meta description, a hero
paragraph, a "whole org at once" list, a feature card, a quick-start step, a mode-segment list, a
pull description, an export-scope list, a stored-data table. **A new part must appear in every list
its siblings appear in**; a removed one must disappear from all of them. Connections shipped in
1.3.0 mentioned in two places while Functions/Modules/Workflows/Schedules were enumerated in nine —
that is the product lying by omission about its own shape.

So do it mechanically, not by memory. When a capability lands or is cut:

```bash
# every place a sibling is enumerated is a place the new part probably belongs
grep -rn "schedules\|Schedules" README.md site/ store/     # pick any established sibling
```

Walk each hit and decide — include, or consciously not. Then the reverse pass: read each surface top
to bottom and check that every claim on it is still true of the code (verify in the source, do not
assume). Do this across `README.md`, `site/index.html`, `site/docs.html`, `site/privacy.html` (what
is stored and where it travels) and `store/store-listing.md`. Only then is the change done.

If a change touches what data leaves the machine, `site/privacy.html` and the Web Store data
disclosures are not optional follow-ups. They are part of the change.

### Anything shown in the UI must also be in the reports

**Every piece of information the panel shows about an item belongs in the HTML and Markdown exports
too.** The exports exist so someone without the extension sees what you see; a number that lives
only on screen makes the report a lesser, quietly incomplete copy — and the person reading it cannot
know what they are missing. When you add a column, a badge, a chip or a line of detail, add it in the
same change to `buildExportHtml` **and** `buildExportMarkdown`, and to the AI context if it helps the
model answer about it. The reverse also holds: nothing in a report should be invented there.

### Numbers are exposed, never interpreted

When surfacing a measurement (size, counts, usage), give the reader the number and what it counts —
not a verdict. No thresholds, no red "too big", no "worst offenders", no quality score. Length is
verbosity, not complexity; a long function may be a clean mapping table and a short one may be a
minefield. State plainly what a metric does **not** capture, the way the health audit states its
coverage gaps, and let the user decide how to read it. We inform; we do not grade their work.

### What to produce, by size of change

**Any code change → nothing to package.** Local testing runs straight off the repository:
`chrome://extensions` → *Load unpacked* → `~/Developer/zoost/src`, then hit reload after edits.
No zip, no reinstall. Just tell me what to look at and what should have changed.

**A change worth keeping → a commit.** Bump `version` in `src/manifest.json`: patch for fixes,
minor for features. Propose the commit message; do not batch unrelated work into one commit.

**A release → tag plus package.** Tag `vX.Y.Z`, push with `--follow-tags`, run `./build.sh`, and
tell me to attach `dist/zoost-X.Y.Z-store.zip` to a GitHub Release for that tag.
**The zip is never committed** — it is a build artefact, reproducible from the tagged commit, and
`dist/` is git-ignored. It lives as a Release attachment, nowhere else.

**A release with user-visible change → store copy as well.** Regenerate whatever in
`store/store-listing.md` no longer matches: description, single purpose, permission
justifications. Hand me the finished text ready to paste, and tell me which dashboard fields to
change alongside the package — they are reviewed together, and an inconsistency between manifest,
description and privacy policy is what delays or fails a review.

**A change touching permissions, data flow or naming → stop and say so before writing code.**
Those have consequences outside the repository.

## How to work with me on this

This project was built by argument, not by dictation, and that is why it holds together. Keep it
that way.

**Give unsolicited critical opinion.** When I share something — a design, a name, a piece of copy,
a licence choice — say what is weak about it, what objection someone will raise, what reads badly.
Do this alongside doing the task, not instead of it. The most valuable moments here have been the
ones where I was told something I had not asked about: that the product name invited a takedown,
that the store description had become factually false, that the licence contradicted my stated
intent, that the interface was asking too much of a first-time user. None of those were requests.

**Do not agree to be agreeable.** If I push a direction and it is wrong, say so and say why, then
do what I decide. I am fine being told I am wrong; I am not fine discovering it later.

**Separate what you verified from what you assume.** If something has not been tested — a
performance threshold, an API response shape, a browser behaviour — say so explicitly rather than
letting it sound settled. Several times today the honest "I could not check this" was worth more
than a confident answer would have been.

**Own mistakes plainly.** When a bug traces back to something you wrote, say that, name the cause,
and fix it. No hedging, no diffusing it into the passive voice.

**One step at a time when I am learning something new.** If I am on unfamiliar ground — git, ssh,
a dashboard I have never opened — give me one instruction, wait for the output, then the next. Ten
steps at once is how people get lost and blame themselves for it.

**Flag scope creep in both directions.** Tell me when a change touches more than I asked for, and
tell me when a feature I am asking for should wait until it can be tested.

**There is no regression testing. You are the safety net.** I test the thing that just changed, and
nothing else — deliberately: the time saved by working with you would go straight back into
re-testing, which defeats the point. So a regression will not be caught by me. It will ship.

This is not a reason to be timid, it is a reason to be precise. Before touching anything **shared** —
a CSS class, a helper, a piece of module state, a constant — find every other user of it and decide
consciously whether they survive the change; prefer adding a new thing over altering a shared one;
and after the change, verify the other users mechanically rather than by eye. This is how the
functions list got its own `.rr/.rn/.rfl/.rc` badge classes instead of widening `.rf/.rl`, which
Modules and Connections rows also use: reusing them would have silently changed those two tabs, and
nobody would have looked. Say plainly which parts of a change you actually exercised and which you
only reasoned about — an honest "not verified" is worth more than a confident guess.

**Follow the established pattern unless there is a real reason not to — and police this yourself.**
When a new thing is an instance of an existing kind (another tab, another list row, another pull,
another export section, another status dot), it must match how its siblings already behave: the
status dot acts on click, the pull re-renders its own view, the preview clears the previous item's
bars, the export gets a section and a TOC entry and a scope toggle. Deviating is allowed only with a
stated, valid reason. **It is your job to catch the missing schematic piece, not mine.** When you
add one of a set, walk the others and check you did everything they do. If I am the one spotting
that the new tab's dot does nothing while every other tab's dot downloads, we have both failed —
but the miss is yours to prevent. Before calling a feature done, diff it against its siblings.

## Style

- British-leaning English in user-facing copy; comments explain **why**, not what.
- Say what a thing does not do, next to what it does. The health audit states its coverage gaps;
  the AI panel states that OpenAI cannot explore on its own; the export dialog flags source code.
  This is deliberate: an honest limitation prevents a bad review.
- Empty states are never silent. "Nothing here" plus the reason plus what to do about it.

## Release routine

The mechanics, once "Definition of done" says a release is warranted:

```bash
# 1. version bumped in src/manifest.json, docs updated, all committed
git tag -a vX.Y.Z -m "Zoost X.Y.Z"
git push --follow-tags
./build.sh                       # -> dist/zoost-X.Y.Z-store.zip
```

Then, by hand: attach that zip to a GitHub Release for the tag, and — if anything user-facing
changed — update the Web Store package, description, privacy policy URL and data disclosures in
the same submission.

Pushing to `main` also deploys `site/` to zoost.it via Cloudflare. Documentation goes live with
the commit, so it must be correct at commit time, not at release time.

The site is static plus one edge function: `site/functions/api/versions.js` reports the Web Store
version, the newest git tag and when `site/` last changed, so the footer shows whether the three are
in step. It reads the **tags** rather than GitHub Releases, because the routine above always creates
a tag while attaching a Release is a manual step that may not happen. Tags are semver-sorted here
rather than trusting the API's unspecified order.

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

- **The edge cache will hide your deploy.** `/api/versions` is cached for an hour and the Worker
  checks the cache before doing anything, so new code can run and still return the old body — no
  error, no 404, just a value that will not change. The key ignores the query string on purpose (so
  the cache cannot be flooded with junk keys), which means it cannot be busted from outside either.
  `CACHE_KEY` therefore carries a version marker: **bump it whenever the payload's shape changes**,
  or the change is invisible until the old entry happens to expire.

Preview deploys are enabled for non-production branches, and the URL is
`<branch>-zoost-it.ivannot.workers.dev`. Anything touching the deployment goes there first and gets
verified with `curl` — endpoint status **and** the pages — before it reaches `main`.

And the lesson that cost two wrong guesses: **a successful deploy says nothing about an endpoint
being live.** Request it and read the status code —
`curl -s -o /dev/null -w '%{http_code}' https://zoost.it/api/versions` — and when something 404s,
find out *what the platform actually is* before moving files around.
