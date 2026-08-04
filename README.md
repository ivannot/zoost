# Zoost

**You built it. It is yours. And the platform gives you no way to see it whole.**

Zoost is a small family of Chrome extensions (Manifest V3), **one per Zoho product**. Each mirrors
what *you* have built inside that product into plain local files you can put under your own Git —
then layers navigation, diagrams, search, an honest health audit, exports and an optional AI
assistant on top of that mirror. None of them writes anything back. Everything runs in your browser.

| | What it mirrors | |
|---|---|---|
| **Zoost — workbench for Zoho CRM** | Deluge functions, module schema, layouts, related lists, workflows, schedules, connections | [Chrome Web Store](https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj) · [about](https://zoost.it/crm.html) · [guide](https://zoost.it/docs.html) |
| **Zoost — workbench for Zoho Analytics** | workspaces, tables, query tables and their SQL, reports, dashboards, foreign keys, lineage, and what nothing depends on any more | *submitted, in review* · [about](https://zoost.it/analytics.html) · [guide](https://zoost.it/docs-analytics.html) |

Neither replaces Zoho's editor. You keep writing and saving where Zoho compiles and validates; these
give you what Zoho's editors do not.

**The rest of this file documents Zoost for Zoho CRM in detail.** The Analytics workbench has its own
[page](https://zoost.it/analytics.html) and [guide](https://zoost.it/docs-analytics.html), kept in
step with it — duplicating a full manual here would be a second copy to keep true, and the one that
went stale would be this one.

**Site:** [zoost.it](https://zoost.it) ·
**Privacy:** [zoost.it/privacy](https://zoost.it/privacy.html) ·
**Releases & verification:** [RELEASES.md](RELEASES.md) ·
**Source:** [github.com/ivannot/zoost](https://github.com/ivannot/zoost)

> Independent, unofficial developer tools. Not affiliated with, endorsed by, or sponsored by
> Zoho Corporation. "Zoho", "Zoho CRM", "Zoho Analytics" and "Deluge" are trademarks of Zoho
> Corporation, used here nominatively to indicate compatibility.

---

## What to expect from this project

Zoost is **free**, licensed under [Apache-2.0](LICENSE), and built and maintained by one person
in his spare time — with substantial help from Claude (which I've come to call Claudio) on
design, code and wording. The judgement calls, and the responsibility for the result, are mine.

- Issues and pull requests are welcome and are read.
- There is **no guaranteed response time**, and no support commitment of any kind.
- Not every issue will be fixed and not every pull request will be merged.
- The licence lets you fork and go your own way. That is a legitimate outcome, not a failure.

If you are about to depend on this for something that matters, read the code — that is precisely
why it is here — and keep in mind that the tool is read-only towards Zoho by design, so the worst
it can do to your org is nothing. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

## Why it's different

The pieces exist scattered across other tools; the **combination** doesn't:

- **Your history, your Git.** Functions are plain `.dg` files on your disk — not a proprietary
  cloud sync. Diff, branch, review, roll back with the tools you already use.
- **The whole org at once.** Functions, modules, workflows, schedules, connections and their relationships,
  in one navigable place and one shareable document.
- **Read-first, on purpose.** No editor overlay to maintain, no false validation. Zoho compiles
  server-side; we give you versioning, comprehension, audit — and now an agent. Zoost never drives
  Zoho's interface: it navigates by URL and reads through the API — it does not script clicks it
  cannot be sure of.
- **An AI that actually knows your org.** Not a generic chatbot: it opens your functions, traces
  your callers, reads your schemas, looks up your connections, searches your code — grounded on the
  current version.

---

## Feature highlights

**Local, Git-friendly version control**
- Pull all Deluge functions to `.dg` source + `.meta.json` sidecars (namespaced folders).
- **Auto-sync on save**: save a function in Zoho and the local file updates automatically.
- Deletions in Zoho are pruned locally **on the next pull** (reconciled at pull time, not intercepted
  live like a save), so your repo stays a faithful mirror.

**Understand the implementation**
- **Reference graph**: for any function, who calls it (impact) and what it calls (dependencies)
  — as a searchable Explorer and a visual node-link graph (Save PDF).
- **Hypertext code**: in the preview, calls to custom functions are clickable — jump to the
  definition and back.
- **Module schema & ER diagram**: browse fields (type, lookup, picklist) and view foreign-key
  relationships as an entity-relationship diagram (pan / zoom / fit / Save PDF).
- **Automation map**: Workflows and Schedules with their triggers, criteria, instant and
  time-based actions, and the functions they invoke — plus on-demand workflow execution stats.
- **Reverse usage**: each function shows where it's wired across the org (blueprint, button,
  schedule, …) via Zoho's own `associated_place` signal — no expensive scans.
- **Connections**: the org's connection catalogue cross-referenced with the functions that use it —
  per function (the connections it calls) and org-wide (usage count, unused, disconnected).
  Plus who last changed each function, and when.
- **Size and outbound calls**: every function shows its length (lines, code lines, KB) and how many
  outbound calls it makes — `invokeurl`, `zoho.crm.*` and the other Zoho service tasks, counted
  outside comments and string literals. Counts, not a score: length is verbosity, not complexity,
  and you decide what the numbers mean. Computed from the sources on disk — no extra Zoho calls,
  nothing stored, so it can never disagree with the file. Sort the list by any of them to see where
  they concentrate; the AI can filter by them too (`list_functions` takes `min_lines` / `min_calls`),
  so "how many functions are over 150 lines" is answered from the numbers, not estimated.

**Health / audit** (candidates to review — never automatic deletions)
- Three tabs — **Functions** (orphans, unresolved calls, ambiguous calls), **Wiring** (broken
  automations, missing module references) and **Size & calls** (longest functions, most outbound
  calls) — each with an explicit coverage note stating exactly what is and isn't analyzed.

**Exports — human-friendly and AI-friendly**
- **Export → HTML**: the entire workspace — functions (highlighted, cross-linked), modules,
  workflows, schedules, connections, and the health report — as one self-contained, navigable HTML file.
- **Export → Markdown**: the whole org as a single `.md` (index + full sources + schemas + connections),
  ready to drop into any external LLM. Work inside the extension *and* outside it.

**AI assistant (bring your own key)**
- A persistent chat, grounded on your real org. **Provider-agnostic BYOK**: Anthropic (Claude)
  or **OpenAI** (ChatGPT). Two providers, both tested — nothing claimed that has not been tried.
- With Anthropic it runs as an **agent with read-only tools** — `get_function`, `who_calls`,
  `get_callees`, `search_code`, `get_module`, `get_workflow`, `get_connection`, `list_functions` —
  so it explores the whole org itself instead of guessing. Every tool it opens is shown in the chat (🔧).
- **Streaming** responses, **Markdown** rendering, and a configurable **tool-step limit** so you
  control how much it reasons — and spends.

**Built for multi-org reality**
- Multiple workspaces, each bound to a specific org + host + instance. If your Zoho tab and your
  workspace don't match, org-bound actions are disabled and a guided bar helps you align them
  (switch workspace, or switch tab — with a clean logout when crossing accounts).

Everything runs locally in your browser. The extension talks to your own Zoho CRM (your session)
and, **only if you enable the AI**, to the LLM provider you configure. Nothing goes to us.

---

## Which commit is on the Web Store

[`RELEASES.md`](RELEASES.md) lists every version submitted to the Store with the commit it was built
from and the SHA-256 of the package that was uploaded. The build is reproducible, so you can check
that yourself rather than take our word for it:

```bash
git checkout <tag> && ./build.sh <app>
shasum -a 256 dist/zoost-<app>-<version>-store.zip
```

Every release from Zoho CRM 1.9.0 onward is built by GitHub Actions from the tagged commit, not on
anyone's laptop, and carries a provenance attestation you can check with one command:

```bash
gh attestation verify zoost-crm-1.9.0-store.zip --repo ivannot/zoost
tools/verify.sh crm 1.9.0
```

`RELEASES.md` also states what it *cannot* tell you: every Zoho CRM version before 1.9.0 predates the
extension's source being in this repository, so none of them has a commit to point at — including the
one the Store is serving while 1.9.0 is in review.

## What is in this repository

Zoost is one root brand with **one extension per Zoho product**. They are separate extensions
deliberately — different host permissions, a different purpose to declare, a different data model —
and they carry their own version numbers.

| Folder | What it is | State |
|---|---|---|
| `apps/crm` | **Zoost — workbench for Zoho CRM.** Everything this README describes. | Released, on the [Chrome Web Store](https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj) |
| `apps/analytics` | **Zoost — workbench for Zoho Analytics.** Mirrors a workspace to disk: every view with its type and folder, the columns and types of every table and query table, the SQL behind each query table as its own `.sql` file, and the lineage between them — plus what nothing depends on. | Released, on the [Chrome Web Store](https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge) |

Nothing is shared between the two yet, on purpose: they read different platforms with different
shapes, and factoring code out before both sides actually need it costs more than the duplication.

---

## Install (developer / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select **`apps/crm`**, not the repository root. Each extension lives in its
   own folder under `apps/` and is loaded separately.
3. Open Zoho CRM in a tab, then open the extension's **side panel**.

## Quick start

1. **Settings → Choose folder…** — pick one dedicated **working folder**. Every workspace will be a
   subfolder inside it at `crm/instance[-sandbox]-orgid`, created automatically. Each Zoost
   product keeps its own subfolder, so one working folder can serve them all.
2. On a Zoho CRM tab, click **+** in the panel. Zoost creates the workspace for that org.
3. Click **Pull all** to mirror functions, modules, layouts, relations, workflows, schedules and connections.
4. `git init` in the workspace folder to start versioning.
5. Explore: open a function, follow its links, open **Graph ↗**, run **Health** (♥), or **Export**.
6. (Optional) **Settings → AI assistant** to set up the assistant (see below).

---

## The AI assistant — setup & how it works

**Set up (BYOK).** Open **Settings** (the gear in the AI panel, or the Settings button):
- **Engine**: Anthropic (Claude) or OpenAI (ChatGPT).
- **Anthropic**: paste an **API key from the Anthropic Console** (console.anthropic.com — this is
  the paid developer API, *not* a Claude.ai subscription) and the exact **model id** from the
  Anthropic docs.
- **OpenAI**: paste an API key from the OpenAI platform and the model id (e.g. `gpt-4o-mini`).
  The endpoint is fixed to `https://api.openai.com/v1`.
- **Max tool steps**: how many explore-then-answer rounds the agent may take (default 8).

Both keys are stored **only in your browser** (`chrome.storage.local`) and each request goes
**directly to the provider you choose** — never to the developer.

**How it works.** The system prompt carries a compact **index of the whole org** (every function
signature, modules, automations, and the connections with their usage counts) plus the function
you're currently viewing. From there the agent
uses read-only tools to fetch exact code and schemas on demand — so it sees the entire org, one
piece at a time, only when needed. Answers reflect the **current** version of the code; there's a
single persistent conversation you clear yourself (switching functions never wipes it).

**Data note.** When the AI is enabled, the relevant Deluge source and org structure are sent to
your chosen LLM provider as context. This is opt-in (no key = no calls). Choose a provider whose
data-handling you're comfortable with; providers typically don't train on API data, and some
offer zero-retention.

---

## The interface

**Top bars**
- **Working folder** — set once; every workspace is a subfolder inside it, identified by the org id
  in its own `.zoost.json` (so renaming a folder or a Zoho portal never orphans a workspace).
- **Workspace select · + · 🗑** — `+` creates the workspace for the org in the active Zoho tab;
  the **🗑** (Remove) button deletes that subfolder (local mirror only, re-pullable).
- Workspace actions: **Pull all · Export (HTML · Markdown) · Health (♥) · AI · Settings ↗ · About**.
- Mode segments: **Functions · Modules · Workflows · Schedules · Connections** — which of these
  appear, and in what order, is yours to set in **Settings → Tabs**, where each also carries a
  **pull** switch — whether `Pull all` asks Zoho for that type at all. Turning a tab off clears it,
  since a tab is usually turned off for an area the account cannot read. A tab your Zoho role has no
  access to removes itself (see below).
- **Every area records when it was last read**, so excluding one from the pull cannot quietly leave a
  four-month-old chapter looking as current as the rest. A section whose data is behind is **unticked
  by default** in the export dialog with the reason and the date — tick it back on and the report says
  so. Both reports state the per-area dates whether or not anything is behind.
- **Pull · Graph ↗ · Functions page ↗ · ↻** (refresh), plus **Find** (name or in-file full-text),
  name toggle (internal/display), a **Type / Kind / Status** filter, and (Functions) a **Sort**
  dropdown — name (grouped by namespace) or lines / API calls / size / last modified, which sorts
  flat — plus a **↑/↓** button for the direction.

**Context bar** shows the active Zoho tab (`instance · org · prod|sandbox`) and whether it matches
the workspace. Not on a Zoho tab → a **Go to Zoho** overlay. Different org than the workspace → a
**mismatch bar** (align via switch workspace / switch tab) and browsing is blocked to avoid mixing
environments.

**Preview** (resizable)
- Functions: highlighted code, line numbers, a **Called by** bar, clickable custom-function calls,
  and **Find in Zoho ↗** (filters the Zoho functions list to it; you open it from Zoho’s own ⋯ menu).
  It also lists the **connections** the function uses (click one to filter the tree to every function
  that uses it) and its last-modified author and date.
- Modules: the fields table, **Records ↗** and **Layouts ↗** (for viewable modules).

**Health (♥)** — tabbed audit over the local workspace, with a coverage note; items link to the
relevant function / workflow / schedule.

**AI** (Ask AI) — a toggle that opens the assistant panel below the button bar; single persistent chat,
streaming + Markdown, tool activity shown inline, ⚙ settings, ↺ Clear.

**Connections** — the org's connections catalogue (pulled with **Pull all**), each with how many
functions use it, the connector, and its status. Filter to **Unused** (used by no function) or
**Disconnected**; open one to see every function that uses it. Answers "who uses this connection?"
from structured data, not a text search.

---

## Exports

- **HTML** (`export/*.html`): one navigable file — functions (cross-linked), modules, workflows,
  schedules, connections, health. Great for reviews, handovers, documentation.
- **Markdown** (`export/*.md`): AI-friendly whole-org context for external LLMs — index + full
  function sources + module schemas.

Both land in your workspace folder, so they're versioned with your Git.

---

## Environments (prod / sandbox)

- Hosts: `crm.zoho.*` and `crmsandbox.zoho.*` (eu/com/in/com.au/jp/zohocloud.ca).
- Each sandbox is a **separate org**; a workspace is bound on **org + host + instance**, so a prod
  workspace can't sync to a sandbox (or vice-versa).
- **Switch tab** navigates the current tab; prod↔sandbox of the same account just navigates, while
  crossing accounts routes through a confirmed logout so you land on the right login.

---

## Privacy & data

- **Function/module/workflow/schedule/connection files** and **exports** are written to the local folder you
  choose (File System Access API). Graph data and the workspace list/binding live in the browser
  (IndexedDB / `chrome.storage.local`). None of this is uploaded anywhere.
- The extension talks to **your own Zoho CRM** using your existing session.
- The **AI assistant is optional**. When enabled, code/schema context and your prompts are sent
  **directly to the LLM provider you configure**, using **your** API key (stored locally). No
  analytics, no ads, no remote code (all scripts are bundled). See
  `../publishing/Zoho-CRM-Deluge-IDE-privacy-policy.md`.

---

## Permissions (why)

- `sidePanel` — the entire UI is a Chrome side panel.
- `storage` — persist the workspace list/binding, generated graph data, and AI settings locally.
- `scripting` — inject the extension's own content scripts into an already-open Zoho tab if
  missing (e.g. after an update).
- `tabs` — detect the active Zoho tab and open/navigate the correct Zoho URL.
- host permissions `crm.zoho.*` / `crmsandbox.zoho.*` — read/save via your authenticated Zoho
  session; `api.anthropic.com` / `api.openai.com` — used **only** if you enable the AI with those
  providers.

---

## How it works (internals)

- Reverse-engineered Zoho CRM settings endpoints (no official function-CRUD API exists): functions,
  modules, fields, workflows, schedules, the connections catalogue (a `/deluge/` endpoint, which
  takes the CSRF token with a different prefix), and each function's `associated_place`.
- Auth = your session cookies + `X-ZCSRF-TOKEN` (from the page's CSRF cookie), scoped per host.
- `hook.js` (MAIN world) detects save PUTs; `content-bridge.js` (ISOLATED world) performs the
  authenticated fetches; the side panel owns the filesystem, the graph, the health engine, the
  exports and the AI agent. Content scripts are auto-injected if missing.

---

## Support

Free, and fully usable for everyone — no features held hostage. If it saves you time and you'd
like to support development:

- **GitHub Sponsors** — https://github.com/sponsors/ivannot (0% fees; needs a GitHub account)
- **Ko-fi** — https://ko-fi.com/ivannot (no account needed)

---

## Known limitations

- The **AI** is powerful but not infallible: answers reflect what's in the workspace (pull to keep
  it fresh) and the tools' coverage (functions/modules/workflows/schedules/connections — not client
  scripts or rules Zoho doesn't expose). Treat its output as an excellent first analysis to verify.
- **Deploy from repo → Zoho** (write-back) is intentionally not implemented; pull + save-sync only.
- OpenAI currently runs **single-shot** (no tool-use yet); Anthropic is the full agent.
- Only Anthropic and OpenAI are supported. Other OpenAI-compatible endpoints (OpenRouter, Azure,
  local models) are deliberately **not** offered: the manifest grants host access to those two
  origins only, and an untested claim is worse than a missing feature.
- The function↔module reference in exports is heuristic string-matching.
- **Size and call counts are counts, not complexity.** Lines measure verbosity; the call count is
  static (it does not know how often a branch runs, or that a call sits inside a loop), and it only
  sees `invokeurl` and the documented `zoho.<service>.*` tasks. Read them as "worth a look", never
  as a score.
- **Connection usage counts cover Deluge functions only.** A connection may also be used by Zoho Flow,
  Circuits, widgets or client scripts, which Zoost does not read — so "unused" means "unused by your
  functions", a candidate to review, not a verdict.
- **What your Zoho role allows can only be discovered by asking.** There is no reliable way to know
  in advance whether a user may read Deluge functions or the connections catalogue, so Zoost finds
  out by pulling: an area Zoho refuses (401/403) is recorded per workspace with the date, its tab is
  hidden, and the reason is stated in **Settings → Tabs**. Roles are per org, so another workspace
  may grant what this one refuses. Pull again to re-check — a verdict is a record of what was asked,
  not a permanent fact. Only an outright HTTP refusal counts: an area that fails for another reason
  is reported as a failure and stays visible.
- The **force-directed Visual graph is not attempted above a few hundred nodes** (it would block the
  window); the Explorer and a focused ER diagram stay fast at any size.

---

## Versioning

The manifest `version` is bumped on every release and this README tracks the feature set. See
`RELEASE_TODO.md` for the running checklist and version log.

---

## Licence and legal

Copyright 2026 Ivan Notaristefano. Licensed under the **Apache License 2.0** — see `LICENSE`
and `NOTICE`.

Zoost is an **independent, unofficial** developer tool. It is not affiliated with, endorsed by,
sponsored by or supported by Zoho Corporation. "Zoho", "Zoho CRM" and "Deluge" are trademarks of
Zoho Corporation, used here in a nominative sense only, to indicate compatibility. Apache 2.0
§6 grants no trademark rights.

The software is provided **AS IS**, without warranties or conditions of any kind. The author
accepts no liability for any loss, damage or data issue arising from its use, and is under no
obligation to provide support, maintenance or fixes.

Zoost reads from the Zoho CRM instance you are already signed in to and writes to a local folder
you choose. It has no server of its own and sends nothing anywhere. **Exports are a different
matter**: the export dialog lets you choose what a file may contain (source code is opt-in and
flagged). Deciding what leaves your machine, and where it goes, is your responsibility and that
of the organisation whose data it is.
