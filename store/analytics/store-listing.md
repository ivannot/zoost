# Zoost - workbench for Zoho Analytics - Chrome Web Store submission copy

Last verified against `apps/analytics/manifest.json` at version **1.0.0** · 3 August 2026

`short_name` and the toolbar tooltip are browser-UI fields and do not appear on the Store listing,
so changing them does not touch anything below.

**Submitted 3 August 2026.** Extension id `gmelnigbgklfjgceldicakkomhgplgge`, listing at
<https://chromewebstore.google.com/detail/gmelnigbgklfjgceldicakkomhgplgge>.

Before every resubmission: re-read §2 against the manifest `description` (they must be identical,
max 132 characters) and confirm every claim below is still true of the code - the same sweep the Zoho CRM
listing gets.

---

## 1. Item name (manifest `name`)

```
Zoost - workbench for Zoho Analytics
```

## 2. Short description (manifest `description`, max 132)

```
Independent, unofficial: mirror a Zoho Analytics workspace to local files - views, columns, foreign keys, query-table SQL.
```

---

## 3. Detailed description (store listing)

```
Zoost mirrors a Zoho Analytics workspace into plain local files, then draws you the map that Zoho Analytics never shows you.

A workspace that has been alive for a few years is hundreds of views. Some are tables, some are query tables with SQL somebody wrote at 2am, most are reports built on top of reports. Zoho Analytics will tell you what a single view depends on if you ask it, one view at a time. It will not tell you the shape of the whole thing, it will not tell you what changed last month, and it will not tell you which of those hundreds of views nothing reads any more.

WHAT IT DOES

- Try it before you connect anything. "+ Sample" writes a workspace of invented data into your working folder - tables with their columns and foreign keys, query tables with their SQL, reports and dashboards - so you can open the census, the ER diagram, the lineage and the exports without a Zoho Analytics tab and without an account. It is generated, never fetched, everything that would talk to the platform is disabled for it, and it is deleted like any other workspace.

- Local mirror, your Git. One pull writes the whole workspace to disk: the view census, the column structure of every table and query table, the relations, and one .sql file per query table. Zoho Analytics keeps no history of anything: change a query table's SQL, a column or a relation and the previous state is gone. Commit the mirror and git diff answers "what changed in this workspace last month".

- Every view, in one list. All of them with type, folder, owner, column count and dates, filtered by type and searched by name, folder or column name. Search a column name to find which tables carry it, before you go looking for where the data lives.

- The structure of anything, including reports. Tables and query tables carry their own columns with Zoho's data types. A report or a pivot has none of its own - so Zoost follows what it is built on and shows you that structure instead, saying whose it is rather than pretending it is the report's.

- Foreign keys on every column, and they are links. Each column shows what it points at and what points at it, both directions, because a foreign key is not symmetric. Click one and you are looking at the other table. Taken from the ER model Zoho Analytics itself draws, with the join written exactly as Zoho writes it.

- ER diagram that stays readable. Tables as boxes, relations as arrows, the join on the arc. Focus one table, adjust the depth, walk the graph by clicking. Click an arc to isolate one relation and fade the rest. Live sliders for spacing, spread and label size, and Save PDF for wall-size prints.

- The SQL of your query tables. Read in the panel, written to disk one file each, and searchable across all of them at once. Each one also records which source tables it reads and which of their columns it actually involves.

- What nothing depends on. Ask Zoho Analytics its own dependency question for every view, and see which ones nothing in the workspace reads. Stated as candidates, never as a verdict: a shared link, a scheduled export, an embedded report or an API consumer is invisible to that graph, and Zoost says so next to the number.

- Design and data, told apart. Zoho Analytics tracks when a view's design last changed separately from when its data last refreshed. A report whose data refreshed nightly for two years but whose design nobody has touched since 2019 is a very different object from one redesigned last week, and the list shows both.

- What Zoho put there, and what you built. The ER model flags system tables - the ones synced from a connected source rather than built by you. The view list marks them; the health view counts them.

- Health audit. Views nothing depends on, tables in no relation at all, views with no description, items that could not be read. Counts and lists, with no thresholds and no score, and every figure stating what it does not cover.

- Exports you can hand over. The whole workspace as one self-contained HTML file, or as Markdown shaped as context for an external AI tool - the Markdown carries the constraints of Zoho Analytics' own SQL dialect too, so an assistant that has never seen Zoho Analytics does not write queries that cannot run. A dialog decides section by section what the file may contain; the SQL is opt-in and flagged every time.

- Optional AI assistant, bring your own key. Anthropic (Claude) or OpenAI (ChatGPT). With Anthropic it runs as an agent with read-only tools over your local mirror - it can read a structure, follow a foreign key, open a query's SQL, search columns, and say what depends on what. It is told what Zoho documents about query-table SQL, so what it writes is a draft you can paste rather than plausible SQL that will not run.
- Your key, your machine, your choice. The API key is stored locally and sent only to the provider you pick. You can protect it with a passphrase you choose - it is then stored encrypted and asked for once per browser session. Off by default, because on a personal machine it buys little and on a shared one a lot, and the trade-off is explained where the choice is made.

WHAT IT DOES NOT DO

- It calls no endpoint that creates, edits or deletes anything in Zoho Analytics. One call is a POST whose URL contains CREATE - ZDBCreateERD.ma, which returns the workspace ER model; it computes rather than creates, and is named here because anyone checking will find it. No creating, editing or deleting a view, ever.
- It never reads the rows in your tables. Structure, relations, SQL and metadata only. The endpoints that return cell values exist and are deliberately not called.
- It does not run, validate or deploy SQL. Whatever the assistant writes is a draft; Zoho Analytics is the only thing that can tell you it compiles.
- Report definitions - which columns a chart puts on which axis, and how it aggregates them - are not covered. The endpoint that carries them also carries the computed series, which is your data.
- Lookups between base tables come from Zoho Analytics' own ER model. What that model does not draw, Zoost does not know.

HOW IT WORKS

Everything happens in your browser, using the Zoho session you are already signed into. There is no server, no account and no telemetry. The mirror is written to a folder you pick with the browser's own folder picker. The only thing that ever leaves your machine is what you send to an AI provider, if you choose to configure one - and never the rows in your tables, because Zoost does not read them.

Free and open source, Apache-2.0. Independent and unofficial: not affiliated with, endorsed by or sponsored by Zoho Corporation.
```

---

## 4. Single purpose description (max 1000)

```
Zoost gives a Zoho Analytics user a read-only, local view of the workspace they have built: it mirrors the workspace's structure - views, tables, columns, relations, the SQL of query tables and the dependencies between them - into plain files on the user's own disk, and presents that mirror as a navigable catalogue, an ER diagram, an audit and a shareable report.

Its single purpose is comprehension and versioning of a Zoho Analytics workspace's design. It reads only what the signed-in user can already see in the Zoho Analytics interface, using their existing session, and never modifies anything in Zoho Analytics and never reads the data rows inside tables.
```

---

## 5. sidePanel justification (max 1000)

```
The extension's entire interface is a side panel shown beside the Zoho Analytics tab. The panel has to stay visible while the user navigates Zoho Analytics, because the workspace it acts on is whichever one the active tab is in - the panel reads the workspace id from the tab's URL and disables every Zoho-bound action when the tab moves to a different workspace. A popup, which closes on every click, cannot do that. No other surface is used.
```

---

## 6. storage justification (max 1000)

```
chrome.storage.local holds the user's own settings, on their machine only: which AI provider is selected, the model name and the API key entered, the maximum number of tool steps for the agent, and the ER diagram's layout defaults. The API key may be protected by a passphrase, in which case only the encrypted form is kept (AES-GCM, key derived with PBKDF2-SHA256). It also carries the graph data from the side panel to the diagram window, which is a separate extension page and cannot be handed the object directly.

chrome.storage.session holds the decrypted API key, only while passphrase protection is on and unlocked. It is memory-only and cleared when the browser closes.

No workspace content is stored there. The mirror is written to the folder the user picks, through the File System Access API. Nothing is sent anywhere, and there is no remote storage of any kind.
```

---

## 7. scripting justification (max 1000)

```
The extension reads the workspace through Zoho Analytics' own endpoints, which are only reachable from a page on the Zoho Analytics origin with the user's session cookies. A content script on that origin performs those authenticated reads and hands the results to the side panel.

chrome.scripting is used for one thing: re-injecting that content script into the Zoho Analytics tab when it is not present - after a navigation, or when the panel is opened on a tab that was already loaded. Without it the panel would work only on tabs opened after the extension started. No code is ever injected into any other site, and nothing is injected that is not part of this extension's own package.
```

---

## 8. tabs justification (max 1000)

```
The panel needs to know which Zoho Analytics workspace the active tab is looking at, because that is what identifies the workspace being mirrored - Zoho Analytics puts the workspace id in the URL. It reads the active tab's URL to establish that, to detect when the user moves to a different workspace so it can disable actions that would otherwise mix two workspaces, and to send messages to the content script on that tab.

It also uses tab access to navigate the current tab to a workspace URL the user asks for, from the "switch tab" action shown when the tab and the mirrored workspace do not match. Tabs on other sites are never read.
```

---

## 9. Host permission justification (max 1000)

```
https://analytics.zoho.eu/*, .com, .in, .com.au, .jp and analytics.zohocloud.ca - the Zoho Analytics data centres. The extension reads the workspace's structure from Zoho Analytics' own endpoints on whichever of these the user's account lives on. It cannot know which one in advance, and the set is exactly the list of Zoho Analytics regions, no wider.

https://api.anthropic.com/* and https://api.openai.com/* - used only by the optional AI assistant, and only if the user configures a provider and an API key. Requests go straight from the browser to the provider the user chose. These two are the only AI endpoints supported, because they are the two that are tested; no other endpoint can be configured.

No other host is requested, and none of these are contacted unless the user acts.
```

---

## 10. Data disclosures (dashboard checkboxes)

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | The API key the user enters stays on their own machine - in `chrome.storage.local`, encrypted with a passphrase if they choose that - and is sent only to the provider they chose |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |
| Website content | **Yes** - see below | Only when the user configures the AI assistant |

The one disclosure to make, and to word carefully:

> If the user configures the optional AI assistant, the parts of the workspace needed to answer their
> question - view and column names, relations, and the SQL of query tables - are sent from their
> browser directly to the AI provider they chose. Nothing is sent to the developer, and the rows
> inside tables are never sent, because the extension does not read them. With no AI provider
> configured, nothing leaves the machine.

Certify: not sold to third parties, not used for purposes unrelated to the single purpose, not used
for creditworthiness or lending.

---

## Notes before submitting

- §2 must be byte-identical to `description` in `apps/analytics/manifest.json`.
- The privacy policy URL must point at a page that covers **this** extension, not only the Zoho CRM one.
  `site/privacy.html` must name Zoho Analytics explicitly before this is submitted.
- Screenshots: the view list with the type filter, a table's columns with foreign keys, the ER
  diagram, the SQL of a query table, the health view. Use a workspace with neutral names.
- Read §3 top to bottom against the code before submitting. Every "WHAT IT DOES NOT DO" line is a
  promise, and the two about never writing and never reading rows are the ones that matter most.
