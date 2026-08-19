# Zoost

**You built it. It is yours. And the platform gives you no way to see it whole.**

Zoost is a small family of Chrome extensions (Manifest V3), **one per Zoho product**. Each mirrors
what *you* have built inside that product into plain local files you can put under your own Git -
then layers navigation, diagrams, search, which functions read and write each module, a health
audit that states its own blind spots, exports
and an optional AI
assistant on top of that mirror. None of them calls an endpoint that writes. Everything runs in
your browser.

| | What it mirrors | |
|---|---|---|
| **Zoost - workbench for Zoho CRM** | Deluge functions, module schema, layouts, related lists, workflows and what they fire, schedules, connections, and what Zoho reports as failing at runtime | [Chrome Web Store](https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj) · [about](https://zoost.it/crm) · [guide](https://zoost.it/docs-crm) |
| **Zoost - workbench for Zoho Analytics** | workspaces, tables, query tables and their SQL, reports, dashboards, foreign keys, lineage, and what nothing depends on any more | [Chrome Web Store](https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge) · [about](https://zoost.it/analytics) · [guide](https://zoost.it/docs-analytics) |

Neither replaces Zoho's editor. You keep writing and saving where Zoho compiles and validates; these
give you what Zoho's editors do not.

**The rest of this file documents Zoost CRM in detail.** Zoost Analytics has its own
[page](https://zoost.it/analytics) and [guide](https://zoost.it/docs-analytics), kept in
step with it - duplicating a full manual here would be a second copy to keep true, and the one that
went stale would be this one.

**Site:** [zoost.it](https://zoost.it) ·
**Privacy:** [zoost.it/privacy](https://zoost.it/privacy) ·
**Releases & verification:** [RELEASES.md](RELEASES.md) ·
**Source:** [github.com/ivannot/zoost](https://github.com/ivannot/zoost)

> Independent, unofficial developer tools. Not affiliated with, endorsed by, or sponsored by
> Zoho Corporation. "Zoho", "Zoho CRM", "Zoho Analytics" and "Deluge" are trademarks of Zoho
> Corporation, used here nominatively to indicate compatibility.

---

## What to expect from this project

Zoost is **free**, licensed under [Apache-2.0](LICENSE), and built and maintained by one person in his spare time - me, with substantial help from Claudio on
design, code and wording. The judgement calls, and the responsibility for how they turn out, are
mine.

- Issues and pull requests are welcome and are read.
- There is **no guaranteed response time**, and no support commitment of any kind.
- Not every issue will be fixed and not every pull request will be merged.
- The licence lets you fork and go your own way. That is a legitimate outcome, not a failure.

If you are about to depend on this for something that matters, read the code - that is precisely
why it is here - and keep in mind that it calls no endpoint that creates, edits or deletes anything in Zoho, so the
worst it can do to your org is nothing. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

## Why it's different

The pieces exist scattered across other tools; the **combination** doesn't:

- **A history for everything you pulled.** Zoho CRM's own version history covers a *function*, one at a
  time. Everything else the pull captures - module schema, layouts, related lists, workflows, schedules,
  connections - arrives on your disk as plain files, so with Git it gets a history too, and one diff
  answers what changed across every kind at once rather than one function at a time. Git is optional:
  without it the mirror is still ordinary files.
- **The whole org at once.** Functions, modules, workflows and the actions they fire, schedules, connections and their relationships,
  in one navigable place and one shareable document.
- **Not an editor, on purpose.** No editor overlay to maintain, no false validation. Zoho compiles
  server-side and versions a function, one at a time; Zoost adds comprehension, an audit, a history
  of the parts Zoho does not version - and now an agent. Zoost never drives
  Zoho's interface: it navigates by URL and reads through the API - it does not script clicks it
  cannot be sure of.
- **An AI that actually knows your org.** Not a generic chatbot: it opens your functions, traces
  your callers, reads your schemas, looks up your connections, searches your code - grounded on the
  current version.

---

## Feature highlights

**Local, Git-friendly version control**
- Pull all Deluge functions to `.dg` source + `.meta.json` sidecars under `functions/<namespace>/`.
  One folder per kind - `functions/`, `modules/` (with `modules/layouts/` inside it),
  `workflows/`, `schedules/`, `connections/`, `failures/`, `export/` - each with its own `index.json`.
- **Auto-sync on save**: save a function in Zoho and the local file updates automatically.
- Deletions in Zoho are pruned locally **on the next pull** (reconciled at pull time, not intercepted
  live like a save), so your repo stays a faithful mirror.

**Understand the implementation**
- **Reference graph**: for any function, who calls it (impact) and what it calls (dependencies)
  - as a searchable Explorer and a visual node-link graph (drag a box to arrange it, take a box off
    the drawing from the circle where an arc meets it, save the arrangement to a file and load it
    back, Save PDF).
- **Hypertext, everywhere**: a name that identifies something the panel can show is a link - a call
  in the code, a rule under **Used in**, an entry in the lineage tab, a foreign key. What has no
  page here stays plain text rather than leading nowhere; a custom button offers its module instead,
  which is where it lives. And because following links is only half of it, the detail pane keeps a
  **history** like a browser's: back, forward, and the whole chain to jump into (Alt+← / Alt+→). It
  spans the tabs and is cleared only by changing workspace.
- **Module schema & ER diagram**: browse fields (type, lookup, picklist) and view foreign-key
  relationships as an entity-relationship diagram (pan / zoom / fit / drag a box to arrange it / take a
  box off the drawing / save and reload the arrangement as a file / Save PDF).
- **Automation map**: Workflows and Schedules with their triggers, criteria, instant and time-based
  actions, and the functions they invoke - plus on-demand workflow execution stats. A rule with actions
  that run *after a delay* carries the count and the delay, **Has scheduled actions** filters the list
  down to those, and each rule shows its **Last run** - all three read from the rule already on disk.
- **Reverse usage**: each function shows where it's wired across the org (blueprint, button,
  schedule, …) via Zoho's own `associated_place` signal - no expensive scans.
- **Connections**: the org's connection catalogue cross-referenced with the functions that use it -
  per function (the connections it calls) and org-wide (usage count, unused, disconnected).
  Plus who last changed each function, and when.
- **What a rule fires**: email notifications, field updates, tasks and webhooks, each an object of its
  own in Zoho and reused across rules. One list with a kind filter, how many rules fire each - read
  from the rules already on disk - and what each one does: the template and sender of a notification,
  the field and value of an update, a task's subject, due date, owner and reminder, a webhook's method
  and URL. About half of them are attached to nothing in a real org, and that is a candidate to review
  rather than a verdict. Zoost never reads a template's content, nor who the recipients are.
- **Execution failures**: what Zoho reports as failing - the function, what invoked it, the reason with its
  line number, how often, and how many runs and failures Zoho counted in the last 24 hours. The one
  thing here that reads a runtime rather than a structure, so it carries the date it was read. Zoho's
  list is read to its first page, and a page that came back full is reported as such rather than
  presented as the whole. It does not re-run anything (that would write) and it does not read the
  input of a failed run.
- **Size and outbound calls**: every function shows its length (lines, code lines, KB) and how many
  outbound calls it makes - `invokeurl`, `zoho.crm.*` and the other Zoho service tasks, counted
  outside comments and string literals. Counts, not a score: length is verbosity, not complexity,
  and you decide what the numbers mean. Computed from the sources on disk - no extra Zoho calls,
  nothing stored, so it can never disagree with the file. Sort the list by any of them to see where
  they concentrate; the AI can filter by them too (`list_functions` takes `min_lines` / `min_calls`),
  so "how many functions are over 150 lines" is answered from the numbers, not estimated.

**Health / audit** (candidates to review - never automatic deletions)
- Three tabs - **Functions** (orphans, unresolved calls, ambiguous calls), **Wiring** (broken
  automations, missing module references) and **Size & calls** (longest functions, most outbound
  calls) - each with an explicit coverage note stating exactly what is and isn't analyzed.

**Exports - human-friendly and AI-friendly**
- **Export → HTML**: the entire workspace - functions (highlighted, cross-linked), modules,
  workflows, the actions they fire, schedules, connections, and the health report - as one self-contained, navigable HTML file.
- **Export → Markdown**: the whole org as a single `.md` (index + full sources + schemas + connections),
  ready to drop into any external LLM. Work inside the extension *and* outside it.

**AI assistant (bring your own key)**
- A persistent chat, grounded on your real org. **Provider-agnostic BYOK**: Anthropic (Claude)
  or **OpenAI** (ChatGPT). Two providers, both tested - nothing claimed that has not been tried.
- With Anthropic it runs as an **agent with read-only tools** - `get_function`, `who_calls`,
  `get_callees`, `search_code`, `get_module`, `list_workflows`, `get_workflow`, `get_connection`,
  `list_functions` -
  so it explores the whole org itself instead of guessing. Every tool it opens is shown in the chat (🔧).
- **Streaming** responses, **Markdown** rendering, and a configurable **tool-step limit** so you
  control how much it reasons - and spends.

**Built for multi-org reality**
- Multiple workspaces, each bound to a specific org + host + instance. If your Zoho tab and your
  workspace don't match, org-bound actions are disabled and a guided bar helps you align them
  (switch workspace, or switch tab - with a clean logout when crossing accounts). While a pull is
  writing a workspace, switching to another one is refused until it finishes - one operation, one
  workspace.

Everything runs locally in your browser. The extension talks to your own Zoho CRM (your session)
and, **only if you enable the AI**, to the LLM provider you configure. Nothing reaches me, ever.

---

## Which commit is on the Web Store

[`RELEASES.md`](RELEASES.md) lists every version submitted to the Store with the commit it was built
from and the SHA-256 of the package that was uploaded. The build is reproducible, so you can check it yourself instead of taking my word:

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
extension's source being in this repository, so none of them has a commit to point at - including
whichever one the Store happens to be serving.

## What is in this repository

Zoost is one root brand with **one extension per Zoho product**. They are separate extensions
deliberately - different host permissions, a different purpose to declare, a different data model -
and they carry their own version numbers.

| Folder | What it is | State |
|---|---|---|
| `apps/crm` | **Zoost - workbench for Zoho CRM.** Everything this README describes. | Released, on the [Chrome Web Store](https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj) |
| `apps/analytics` | **Zoost - workbench for Zoho Analytics.** Mirrors a workspace to disk: every view with its type and folder, the columns and types of every table and query table, the SQL behind each query table as its own `.sql` file, and the lineage between them - plus what nothing depends on. | Released, on the [Chrome Web Store](https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge) |

Nothing is shared between the two yet, on purpose: they read different platforms with different
shapes, and factoring code out before both sides actually need it costs more than the duplication.

---

## Tests

```bash
bash tests/run.sh
```

Unit tests, three structural checkers and both builds. No framework and nothing to install: node's
own test runner and Python's `unittest`. Every case is a defect that actually occurred, and the
checkers are tested too - two of them shipped broken, and a checker that reports success over the
thing it was built to catch is worse than no checker.

What it does **not** cover: anything needing a DOM, a browser, a file handle or Zoho. Helpers are
lifted out of the panels and run in isolation, which proves the logic and not the wiring.

## Install (developer / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select **`apps/crm`**, not the repository root. Each extension lives in its
   own folder under `apps/` and is loaded separately.
3. Open Zoho CRM in a tab, then open the extension's **side panel**.

## Quick start

1. **Settings → Choose folder…** - pick one dedicated **working folder**. Every workspace will be a
   subfolder inside it at `crm/instance[-sandbox]-orgid`, created automatically. Each Zoost
   product keeps its own subfolder, so one working folder can serve them all.
2. On a Zoho CRM tab, click **+** in the panel. Zoost creates the workspace for that org.
3. Click **Pull all** to mirror functions, modules, layouts, relations, workflows, schedules and connections.
4. Optional: `git init` in the workspace folder to start versioning. Everything else works without it.
5. Explore: open a function, follow its links, open the **Wiring** diagram, run **Health** (♥), or **Export**.
6. (Optional) **Settings → AI assistant** to set up the assistant (see below).

**Or press `+ Sample` and skip all of it.** It writes a workspace of invented data into the working
folder - a couple of hundred functions with real call chains, modules with lookups, workflows,
schedules and connections - so you can open the tree, the graph, the audit and the exports before
pointing Zoost at anything of your own. It needs no Zoho tab and no account, it is generated rather
than fetched, everything that would talk to Zoho is disabled for it, and it is deleted like any other
workspace. The same button is on the **Not on a Zoho tab** screen, which is where a fresh install
lands.

---

## The AI assistant - setup & how it works

**Set up (BYOK).** Open **Settings** (the gear in the AI panel, or the Settings button):
- **Engine**: Anthropic (Claude) or OpenAI (ChatGPT).
- **Anthropic**: paste an **API key from the Anthropic Console** (console.anthropic.com - this is
  the paid developer API, *not* a Claude.ai subscription) and the exact **model id** from the
  Anthropic docs.
- **OpenAI**: paste an API key from the OpenAI platform and the model id (e.g. `gpt-4o-mini`).
  The endpoint is fixed to `https://api.openai.com/v1`.
- **Max tool steps**: how many explore-then-answer rounds the agent may take (default 8).
- **Forget**, per provider: clears its model and key on the next Save. It is the only place an empty
  field means *erase* rather than *keep*, and the way out if a passphrase is lost.
- The **Engine** selector refuses a provider with no model or no key, naming what is missing, rather
  than letting the panel fail at the first question.

Both keys are stored **only in your browser** (`chrome.storage.local`) and each request goes
**directly to the provider you choose** - never to the developer.

**Protecting the key (optional).** By default the key is stored in clear text, because Chrome offers
extensions no encryption at rest and no credential store: a key the extension can read on its own is a
key anyone with the browser profile can read, and encrypting it with a secret kept beside it would be
protection in appearance only. Settings therefore offers **Protect the API key with a passphrase** -
PBKDF2-SHA256 then AES-GCM-256, both from the browser's own Web Crypto, with only ciphertext left on
disk. The passphrase is asked once per browser session, in the AI panel, and the unlocked key is held
in memory (`chrome.storage.session`) until the browser closes. It is off by default because the trade
is the user's to price, and **there is no recovery**: if it is lost, **Remove the protection** in Settings drops the encrypted key, turns the protection off and keeps everything else, and the API key is pasted in again. It can be turned back off at any time, which asks for the current passphrase - clear text means decrypting first - and a wrong or missing one changes nothing rather than discarding the key. What
it protects is the key at rest - a copied profile, a backup, another user of the machine - not a key
already unlocked in a running browser.

**How it works.** The system prompt carries a compact **index of the whole org** (every function
signature, modules, automations, and the connections with their usage counts) plus the function
you're currently viewing. From there the agent
uses read-only tools to fetch exact code and schemas on demand - so it sees the entire org, one
piece at a time, only when needed. Answers reflect the **current** version of the code; there's a
single persistent conversation you clear yourself (switching functions never wipes it).

**Data note.** When the AI is enabled, the relevant Deluge source and org structure are sent to
your chosen LLM provider as context. This is opt-in (no key = no calls). Choose a provider whose
data-handling you're comfortable with; providers typically don't train on API data, and some
offer zero-retention.

---

## The interface

**Top bars**
- **Working folder** - set once; every workspace is a subfolder inside it, identified by the org id
  in its own `.zoost.json` (so renaming a folder or a Zoho portal never orphans a workspace).
- **Workspace select · + · ✎ · 🗑** - `+` creates the workspace for the org in the active Zoho tab;
  **✎** gives it a name of your own, shown instead of the folder's (the platform's own name stays in
  the tooltip and in the bar underneath, and clearing the field goes back to it); the **🗑** (Remove)
  button deletes that subfolder (local mirror only, re-pullable).
- Workspace actions: **Pull all · Export (HTML · Markdown) · Health (♥) · AI · Settings ↗ · About**.
- Mode segments: **Functions · Modules · Workflows · Schedules · Connections** - which of these
  appear, and in what order, is yours to set in **Settings → Tabs**, where each also carries a
  **pull** switch - whether `Pull all` asks Zoho for that type at all. Turning a tab off clears it,
  since a tab is usually turned off for an area the account cannot read. A tab your Zoho role has no
  access to removes itself (see below).
- **Every area records when it was last read**, so excluding one from the pull cannot quietly leave a
  four-month-old chapter looking as current as the rest. A section whose data is behind is **unticked
  by default** in the export dialog with the reason and the date - tick it back on and the report says
  so. Both reports state the per-area dates whether or not anything is behind.
- **Pull · Wiring · Functions page ↗ · ↻** (refresh), plus **Find** (name or in-file full-text),
  name toggle (internal/display), a **Type / Kind / Status** filter, and (Functions) a **Sort**
  dropdown - name (grouped by namespace) or lines / API calls / size / last modified, which sorts
  flat - plus a **↑/↓** button for the direction.

**Context bar** shows the active Zoho tab (`instance · org · prod|sandbox`) and whether it matches
the workspace. Not on a Zoho tab → a **Go to Zoho** overlay. Different org than the workspace → a
**mismatch bar** (align via switch workspace / switch tab) and browsing is blocked to avoid mixing
environments.

**Preview** (resizable)
- Functions: highlighted code, line numbers, a **Called by** bar, clickable custom-function calls,
  a history (◂ ▸ ⋯) over everything you have opened,
  and **Find in Zoho ↗** (filters the Zoho functions list to it; you open it from Zoho's own ⋯ menu).
  It also lists the **connections** the function uses (click one to filter the tree to every function
  that uses it) and its last-modified author and date.
- Modules: the fields table, **Records ↗** and **Layouts ↗** (for viewable modules).

**Health (♥)** - tabbed audit over the local workspace, with a coverage note; items link to the
relevant function / workflow / schedule.

**AI** (Ask AI) - a toggle that opens the assistant panel below the button bar; single persistent chat,
streaming + Markdown, tool activity shown inline, ⚙ settings, Clear.

**Connections** - the org's connections catalogue (pulled with **Pull all**), each with how many
functions use it, the connector, and its status. Filter to **Unused** (used by no function) or
**Disconnected**; open one to see every function that uses it. Answers "who uses this connection?"
from structured data, not a text search.

---

## Exports

- **HTML** (`export/*.html`): one navigable file - functions (cross-linked), modules, workflows,
  schedules, connections, health. Great for reviews, handovers, documentation.
- **Markdown** (`export/*.md`): AI-friendly whole-org context for external LLMs - index + full
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

Both manifests also declare `script-src 'self'; object-src 'self'; base-uri 'self'; form-action 'none'`.
The first two restate what Manifest V3 enforces anyway; the last two are stricter than the default and
free, because nothing shipped uses a form or a `<base>`. It is written down because every other
security property here is.

- `sidePanel` - the entire UI is a Chrome side panel.
- `storage` - persist the workspace list/binding, generated graph data, and AI settings locally.
- `scripting` - inject the extension's own content scripts into an already-open Zoho tab if
  missing (e.g. after an update).
- `tabs` - detect the active Zoho tab and open/navigate the correct Zoho URL.
- host permissions `crm.zoho.*` / `crmsandbox.zoho.*` - read/save via your authenticated Zoho
  session; `api.anthropic.com` / `api.openai.com` - used **only** if you enable the AI with those
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

Free, and fully usable for everyone - no features held hostage. If it saves you time and you'd
like to support development:

- **GitHub Sponsors** - https://github.com/sponsors/ivannot (0% fees; needs a GitHub account)
- **Ko-fi** - https://ko-fi.com/ivannot (no account needed)

---

## Known limitations

- The **AI** is powerful but not infallible: answers reflect what's in the workspace (pull to keep
  it fresh) and the tools' coverage (functions/modules/workflows/schedules/connections - not client
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
  Circuits, widgets or client scripts, which Zoost does not read - so "unused" means "unused by your
  functions", a candidate to review, not a verdict.
- **What your Zoho role allows can only be discovered by asking.** There is no reliable way to know
  in advance whether a user may read Deluge functions or the connections catalogue, so Zoost finds
  out by pulling: an area Zoho refuses (401/403) is recorded per workspace with the date, its tab is
  hidden, and the reason is stated in **Settings → Tabs**. Roles are per org, so another workspace
  may grant what this one refuses. Pull again to re-check - a verdict is a record of what was asked,
  not a permanent fact. Only an outright HTTP refusal counts: an area that fails for another reason
  is reported as a failure and stays visible.
- The **force-directed layout is not attempted above 1200 nodes** (it would block the window - the
  whole path is about 2.1s at that number and about 7s at two thousand); the Explorer and a focused
  ER diagram stay fast at any size.

---

## Versioning

The manifest `version` is bumped on every release and this README tracks the feature set. See
`RELEASE_TODO.md` for the running checklist and version log.

---

## Licence and legal

Copyright 2026 Ivan Notaristefano. Licensed under the **Apache License 2.0** - see `LICENSE`
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
