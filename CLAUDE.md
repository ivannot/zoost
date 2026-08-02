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

If a change touches what data leaves the machine, `site/privacy.html` and the Web Store data
disclosures are not optional follow-ups. They are part of the change.

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
