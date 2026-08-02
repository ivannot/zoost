# Zoost

**Turn your Zoho CRM org into a local, versionable, navigable codebase — and talk to it.**

A Chrome extension (Manifest V3) that mirrors your Zoho CRM **Deluge functions, module schema,
workflows and schedules** into plain local files you can put under your own Git — then layers on
a dependency graph, an ER diagram, an honest health audit, a whole-org HTML export, and an
**AI assistant that can read and reason over your entire codebase** (bring your own key).

It does **not** replace Zoho's editor. You keep writing and saving where Zoho compiles and
validates; this gives you everything Zoho's editor doesn't.

**Install:** [Chrome Web Store](https://chromewebstore.google.com/detail/flffecjpbmjfonhoojaiemgjanbjkmpj) ·
**Guide:** [zoost.it/docs](https://zoost.it/docs.html) ·
**Privacy:** [zoost.it/privacy](https://zoost.it/privacy.html) ·
**Source:** [github.com/ivannot/zoost](https://github.com/ivannot/zoost)

> Independent, unofficial developer tool. Not affiliated with, endorsed by, or sponsored by
> Zoho Corporation. "Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used
> here nominatively to indicate compatibility.

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
- **The whole org at once.** Functions, modules, workflows, schedules and their relationships,
  in one navigable place and one shareable document.
- **Read-first, on purpose.** No editor overlay to maintain, no false validation. Zoho compiles
  server-side; we give you versioning, comprehension, audit — and now an agent. Zoost never drives
  Zoho's interface: it navigates by URL and reads through the API — it does not script clicks it
  cannot be sure of.
- **An AI that actually knows your org.** Not a generic chatbot: it opens your functions, traces
  your callers, reads your schemas, searches your code — grounded on the current version.

---

## Feature highlights

**Local, Git-friendly version control**
- Pull all Deluge functions to `.dg` source + `.meta.json` sidecars (namespaced folders).
- **Auto-sync on save**: save a function in Zoho and the local file updates automatically.
- Deletions in Zoho are pruned locally, so your repo stays a faithful mirror.

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

**Health / audit** (candidates to review — never automatic deletions)
- Two tabs — **Functions** (orphans, unresolved calls, ambiguous calls) and **Wiring** (broken
  automations, missing module references) — each with an explicit coverage note stating exactly
  what is and isn't analyzed.

**Exports — human-friendly and AI-friendly**
- **Export HTML**: the entire workspace — functions (highlighted, cross-linked), modules,
  workflows, schedules, and the health report — as one self-contained, navigable HTML file.
- **Export AI (Markdown)**: the whole org as a single `.md` (index + full sources + schemas),
  ready to drop into any external LLM. Work inside the extension *and* outside it.

**AI assistant (bring your own key)**
- A persistent chat, grounded on your real org. **Provider-agnostic BYOK**: Anthropic (Claude)
  or **OpenAI** (ChatGPT). Two providers, both tested — nothing claimed that has not been tried.
- With Anthropic it runs as an **agent with read-only tools** — `get_function`, `who_calls`,
  `get_callees`, `search_code`, `get_module`, `get_workflow`, `list_functions` — so it explores
  the whole org itself instead of guessing. Every tool it opens is shown in the chat (🔧).
- **Streaming** responses, **Markdown** rendering, and a configurable **tool-step limit** so you
  control how much it reasons — and spends.

**Built for multi-org reality**
- Multiple workspaces, each bound to a specific org + host + instance. If your Zoho tab and your
  workspace don't match, org-bound actions are disabled and a guided bar helps you align them
  (switch workspace, or switch tab — with a clean logout when crossing accounts).

Everything runs locally in your browser. The extension talks to your own Zoho CRM (your session)
and, **only if you enable the AI**, to the LLM provider you configure. Nothing goes to us.

---

## Install (developer / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open Zoho CRM in a tab, then open the extension's **side panel**.

## Quick start

1. **Settings → Choose folder…** — pick one dedicated **working folder**. Every workspace will be a
   subfolder inside it, created automatically and named `instance[-sandbox]-orgid`.
2. On a Zoho CRM tab, click **+** in the panel. Zoost creates the workspace for that org.
3. Click **Pull all** to mirror functions, modules, layouts, relations, workflows and schedules.
4. `git init` in the workspace folder to start versioning.
5. Explore: open a function, follow its links, open **Graph ↗**, run **Health**, or **Export**.
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
signature, modules, automations) plus the function you're currently viewing. From there the agent
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
- **Workspace select · + · Remove** — `+` creates the workspace for the org in the active Zoho tab;
  `Remove` deletes that subfolder (local mirror only, re-pullable).
- Workspace-wide actions: **Pull all · Export HTML · Export AI · Health · Ask AI · Settings ↗ · About**.
- Mode segments: **Functions · Modules · Workflows · Schedules**.
- **Graph ↗ · Functions page ↗ · Refresh**, plus **Find** (name or in-file full-text),
  name toggle (internal/display), and type chips.

**Context bar** shows the active Zoho tab (`instance · org · prod|sandbox`) and whether it matches
the workspace. Not on a Zoho tab → a **Go to Zoho** overlay. Different org than the workspace → a
**mismatch bar** (align via switch workspace / switch tab) and browsing is blocked to avoid mixing
environments.

**Preview** (resizable)
- Functions: highlighted code, line numbers, a **Called by** bar, clickable custom-function calls,
  and **Find in Zoho ↗** (filters the Zoho functions list to it; you open it from Zoho’s own ⋯ menu).
- Modules: the fields table, **Records ↗** and **Layouts ↗** (for viewable modules).

**Health** — tabbed audit over the local workspace, with a coverage note; items link to the
relevant function / workflow / schedule.

**Ask AI** — a toggle that opens the assistant panel below the button bar; single persistent chat,
streaming + Markdown, tool activity shown inline, ⚙ settings, ↺ Clear.

---

## Exports

- **HTML** (`export/*.html`): one navigable file — functions (cross-linked), modules, workflows,
  schedules, health. Great for reviews, handovers, documentation.
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

- **Function/module/workflow/schedule files** and **exports** are written to the local folder you
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

- Reverse-engineered CRM settings endpoints (no official function-CRUD API exists): functions,
  modules, fields, workflows, schedules, and each function's `associated_place`.
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
  it fresh) and the tools' coverage (functions/modules/workflows/schedules — not client scripts or
  rules Zoho doesn't expose). Treat its output as an excellent first analysis to verify.
- **Deploy from repo → Zoho** (write-back) is intentionally not implemented; pull + save-sync only.
- OpenAI currently runs **single-shot** (no tool-use yet); Anthropic is the full agent.
- Only Anthropic and OpenAI are supported. Other OpenAI-compatible endpoints (OpenRouter, Azure,
  local models) are deliberately **not** offered: the manifest grants host access to those two
  origins only, and an untested claim is worse than a missing feature.
- The function↔module reference in exports is heuristic string-matching.

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
