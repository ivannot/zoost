# Zoost — Chrome Web Store submission copy

Last verified against `apps/crm/manifest.json` at version **1.7.1** · 3 August 2026

`short_name` and the toolbar tooltip are browser-UI fields and do not appear on the Store listing,
so changing them does not touch anything below.

---

## 1. Item name (manifest `name`)

```
Zoost — workbench for Zoho CRM
```

## 2. Short description (manifest `description`, max 132)

```
Independent developer & admin workbench for Zoho CRM: version Deluge locally, explore schema, relations, workflows, connections.
```

---

## 3. Detailed description (store listing)

```
Zoost turns your Zoho CRM org into a local, version-controllable, searchable codebase — and then draws you a map of it.

If you administer or develop on Zoho CRM you know the gaps: no external editor, no Git, no way to search across all your functions at once, no way to see what calls what before you change something, and no quick answer to "what is the API name of that related list?", and no way to tell which functions still use a given connection. Zoost fills them, with no server and no account: everything it reads lands on your own disk. The single exception is the optional AI assistant, which stays off until you enter your own API key — described in full below.

WHAT IT DOES

- Local mirror, your Git. Pull every Deluge function to plain .dg files with .meta.json sidecars, in namespaced folders. Commit, diff, branch and roll back with your own tools. Functions deleted in Zoho are pruned locally on the next pull, so the folder stays a faithful mirror rather than an accumulating pile.

- Search across every function at once. Full-text search over all your Deluge sources — the closest thing to grep for Zoho CRM, and something the platform does not offer. Find every reference to a field, a module, an endpoint or a hardcoded id before you change it.

- Auto-sync on save. Save a function in the native Zoho editor and the matching local file updates by itself, so your working copy always mirrors production.

- Reference graph. For any function: which functions call it (the impact if you change it) and which it calls (its dependencies) — as a searchable explorer and as a visual node-link diagram. Calls to custom functions are clickable in the code preview: jump to the definition and back.

- Reverse usage. Where each function is actually wired across the org — blueprint, button, schedule and so on — read from Zoho's own signal, with no expensive scans.

- Module schema, fields and layouts. Every field with type, lookup target, picklist values and mandatory flag. A layout matrix shows, per field, which layouts it belongs to and where it is required — and flags fields that are on no layout at all.

- Relations, with the names you actually need. The API name of a related list is not the api name of either module, and it is what zoho.crm.getRelatedRecords() requires. Zoost catalogues every relation with its target module, the lookup or linking module behind it, and the Deluge call ready to copy.

- ER diagram that stays readable. Modules as tables, foreign keys as arrows. Focus a module, adjust depth, walk the graph by clicking. A relation-first mode pushes modules into the background and brings relation names forward. Click an arc to isolate one relation and fade everything else. Live sliders for spacing and label size, an all-modules scope, and Save PDF for wall-size prints.

- Fits the access you actually have. Not every Zoho user may read Deluge or the connections catalogue, and no API says so in advance — so Zoost finds out by asking, once, and records the answer with the date. An area your role is refused is skipped on later pulls, nothing is written for it, and its tab is removed rather than sitting there greyed out; the reason is in Settings, which can also re-check, since roles change. You can hide and reorder the tabs yourself too, and choose which types Pull all should ask for at all.

- Every part knows when it was last read. Because a type can be excluded from a pull, the mirror states per area when it last came from Zoho. A report section whose data is behind is unticked in the export dialog, with the date and the reason — you can include it anyway, and the report then says so. Both reports carry the per-area dates whether or not anything is behind.

- Automation map. Workflows with triggers, criteria, instant and time-based actions and the functions they invoke; schedules with frequency, status and target function.

- Connections, cross-referenced. The org's connection catalogue with its connector, status and scopes — and, for each one, how many of your functions use it and exactly which. Filter to the ones no function uses, or the ones configured but not connected. Every function also lists the connections it uses, and who last changed it.

- Size and outbound calls. Every function shows its length and how many outbound calls it makes — invokeurl, zoho.crm and the other Zoho service tasks, counted outside comments and string literals — so you can see at a glance where length and API cost concentrate. These are plain counts with no threshold and no verdict: length is verbosity, not complexity, and the interpretation is yours. Computed from the local mirror, with no extra calls to Zoho.

- Health audit. Orphan candidates, unresolved and ambiguous calls, broken automations, lookups pointing at modules that are not there. Every check states what it does and does not analyse. Candidates to review — never automatic deletions.

- Exports you can hand over. The whole workspace as one self-contained cross-linked HTML file, or as Markdown shaped as context for an external LLM. A dialog decides section by section what the file may contain; source code is opt-in and flagged every time.

- Optional AI assistant, bring your own key. Anthropic (Claude) or OpenAI (ChatGPT). With Anthropic it runs as an agent with read-only tools and explores your org itself, showing every tool call; with OpenAI it answers in one pass from the org index and the function you have open. The chat states which engine is active and what it can do.

- Built for multi-org reality. One working folder holds a subfolder per Zoho org, created on demand. Each workspace is bound to its org, host and instance, so a production workspace can never be synced against a sandbox by mistake.

SAFE BY DESIGN

Zoost reads from the Zoho CRM instance you are already signed in to and writes to a local folder you choose. It has no server of its own: no analytics, no telemetry, no tracking, no remotely hosted code, and nothing is ever sent to the developer.

The one exception is the optional AI assistant, which is off until you enter your own API key. Once enabled, the content it needs to answer you — including Deluge source code — is sent directly from your browser to the provider you configured (Anthropic or OpenAI) and is processed under their terms. If your organisation restricts sending source code to third-party AI services, leave that feature off; everything else stays local.

Zoost never writes to Zoho. It reads metadata and function source only. It does not read, download or export your Zoho CRM records — no contacts, no deals, no customer data.

WHO IT'S FOR

Zoho CRM administrators, developers and consultants who want proper code management and a way to understand an org: diffs, history, impact analysis, schema documentation, relation lookup and backups.

REQUIREMENTS

- Be signed in to Zoho CRM in the same browser.
- Choose one local working folder; workspaces are created inside it automatically.

DOCUMENTATION AND PRIVACY

Source code: https://github.com/ivannot/zoost
Guide: https://zoost.it/docs-crm.html
Privacy policy: https://zoost.it/privacy.html
Home: https://zoost.it

Free and open source, licensed under the Apache License 2.0. Maintained in spare time on a best-effort basis; there is no guaranteed support or response time.

NOT AFFILIATED

Zoost is an independent, unofficial developer tool. It is not affiliated with, endorsed by, sponsored by or supported by Zoho Corporation. "Zoho", "Zoho CRM" and "Deluge" are trademarks of Zoho Corporation, used here in a nominative sense only, to indicate compatibility.
```

---

## 4. Single purpose description (max 1000)

```
Zoost has one purpose: to give a Zoho CRM administrator or developer a local, read-only mirror of their own org's Deluge code and configuration, and the tools to navigate and document it.

Working from the Zoho CRM session the user is already signed in to, it reads Deluge function sources, module and layout metadata, related lists, workflows, schedules and the org's connection catalogue, and writes them as plain files into a local folder the user selects. On top of that mirror it provides search across all sources, a call-reference graph, an entity-relationship diagram, a catalogue of related-list API names, a cross-reference of which functions use which connection, a health audit and offline exports.

Every feature serves that single purpose: understanding and version-controlling a Zoho CRM implementation. Zoost never writes back to Zoho, never touches Zoho CRM records, and does nothing on any other website.
```

## 5. sidePanel justification (max 1000)

```
The extension's entire user interface is a Chrome side panel.

This is deliberate rather than cosmetic: the tool is used side by side with Zoho CRM. The user reads a function in the panel while the corresponding record or setup page is open in the tab, jumps from a function to its callers, and moves between the panel and the Zoho editor continuously. A popup would close on every click on the page, and an injected overlay would modify Zoho's own interface, which we explicitly avoid.

The side panel also lets the extension observe which Zoho tab is active and keep the local workspace aligned with it, which is what makes the production/sandbox guard possible.

No content is injected into the page for UI purposes. The sidePanel permission is used only to open and manage that panel.
```

## 6. storage justification (max 1000)

```
storage is used to persist the user's own settings between sessions, using chrome.storage.local only. Nothing is stored remotely and nothing is synced.

What is kept:
- Which AI engine the user selected, the model id, and the API key they entered (the assistant is optional and off by default). The key is used only to call the provider the user chose.
- Export defaults: which sections a generated export file may contain.
- Diagram preferences: spacing, spread and label size for the ER diagram.
- Which side panel tabs the user shows, in what order, and which of them a pull should ask Zoho for.
- A display-only copy of which data types the user's Zoho role was granted or refused in the workspace currently open, so the options page can explain why a tab is unavailable. The authoritative record is a file in the user's own folder; this copy is only read into a sentence.
- A small timestamp used so the side panel notices when settings are changed in the options page.

No browsing data, no Zoho CRM data and no personal information are placed in storage. The mirrored Deluge sources and metadata are not stored here: they are written as ordinary files into the local folder the user selected, through the File System Access API.
```

## 7. scripting justification (max 1000)

```
scripting is used to inject two small scripts into Zoho CRM tabs only, and nowhere else.

1. A bridge script that calls the Zoho CRM API from the page's own origin, using the session the user is already signed in with. Running in the page context is what allows the extension to read the user's own functions, module metadata, layouts, related lists, workflows, schedules and the names of the org's connections without asking for separate credentials, and strictly within that user's existing Zoho permissions.

2. A hook that detects when the user saves a Deluge function in the native Zoho editor, so the corresponding local file can be updated automatically and the local mirror stays faithful.

Both scripts are packaged with the extension; no remote code is fetched or executed. They read only; they never modify the Zoho page, its content, or any data in the Zoho CRM.
```

## 8. tabs justification (max 1000)

```
tabs is used to identify the Zoho CRM tab the user is currently working in, and to navigate to Zoho pages on request.

Specifically:
- To read the URL of the active tab and determine which Zoho CRM instance, data centre and organisation it belongs to. This is the core of the environment guard: each local workspace is bound to one org, and if the active tab belongs to a different org — production versus sandbox in particular — every Zoho-bound action is disabled until they match. Without this, a sandbox pull could silently overwrite a production mirror.
- To open or focus a Zoho CRM page when the user clicks an explicit link in the extension, such as the functions list filtered to a function, a module's records tab, or its layout settings. The extension navigates to these pages by URL; it does not drive the Zoho interface or click on the user's behalf.

The extension does not read browsing history, does not enumerate tabs unrelated to Zoho CRM, and takes no action on any other site.
```

## 9. Host permission justification (max 1000)

```
Two groups of hosts, both strictly necessary.

1. Zoho CRM domains — crm.zoho.com, .eu, .in, .com.au, .jp, zohocloud.ca, the matching crmsandbox.* hosts, and one.zoho.* — cover every Zoho data centre and their sandboxes. The extension calls the Zoho CRM API on these origins, using the user's existing session, to read their own Deluge functions and configuration metadata. The multiple domains are not a widening of scope: they are the same product, and a user's org lives on exactly one of them. The extension is inert on every other site.

2. api.anthropic.com and api.openai.com are needed only by the optional AI assistant, and only after the user enters their own API key for one of them. The request goes directly from the browser to that provider. These two origins are the only AI destinations the extension can reach; no other endpoint is configurable.

No host access is requested for any other website.
```

---

## Notes before submitting

- URLs in the store description are allowed; the three above point to first-party pages on zoost.it.
- Update the Privacy policy URL field in the dashboard to `https://zoost.it/privacy.html`.
- The old description claimed the extension "never sends your code or data to the developer or any third party". That was true before the AI assistant existed and is no longer accurate. The text above corrects it explicitly.
- Data-use disclosures in the dashboard should be reviewed: with the AI assistant, "website content" (the user's own source code) is transmitted to a third party at the user's initiative. Declare it rather than leaving the previous "no data collected" answers untouched.
