# The move out of the side panel, reviewed

Four scans over the change that made Zoost its own window: the lifecycle, the tab resolution and the
safety check, the wide layout, and the rename plus the stylesheet extraction. Read-only; every claim
below was verified against the source here before it was acted on.

## The class three of the four scans found independently

**`chrome.tabs.query({active: true, currentWindow: true})` stopped meaning what it was written to
mean, and nothing said so.** Inside a side panel, the active tab of the current window *is* the page
the reader is looking at. From a window of its own, `currentWindow` is Zoost's window and its active
tab is `workbench.html` - so six call sites went on asking a question whose answer had become a
constant. Each one failed by returning `null`, which is also what it returns on an ordinary day.

What it cost, all of it reachable and none of it reported by anything:

- **The twin offer was dead in both products.** `twinTab()` could not match, so the context mark and
  the whole «you have the other product's platform open» box were unreachable markup. This is the
  feature that had been restored *that same morning* after a different defect swallowed it.
- **The CRM's «switch workspace» opened a new tab and left a zombie session.** With no id, both
  branches fell to `tabs.create`: the same-account branch made a tab per press, and the
  different-account branch loaded the logout somewhere new while the tab holding the session it had
  just ended sat there looking alive. The confirm dialog said «takes this tab», and it did not.
- **Analytics' «Go to Zoho Analytics ↗» made another tab on every press**, in a window that was
  never raised - a fix its own twin had learnt twenty-five lines higher in the same file.
- Two more resolvers were permanently `null` behind fallbacks, costing a wasted message per pass.

The rule, and it is not about tabs: **when a surface moves, the things that were true *because of
where it was* are not a list anybody has.** «The tab in front» was an assumption about the panel's
position, spread over six files under three different names, and the commit that moved the panel
fixed the one instance its author happened to be testing. A `grep` for the *idiom* -
`currentWindow: true` - found all six in one line, and that grep is the step that was missing.
Where a position-dependent idiom is used at all, it is used once and given a name; «the tab in
front» does not exist any more, so what is left is `tabId()` / `anyAnalyticsTabId()`, one question
per product: *which of the open Zoho tabs belongs to this workspace*.

## The safety check was fail-open through an await

`expectedMatches` in both content bridges - the authority this product rests on - returns `true` for
a command carrying no expectation. Analytics built that expectation from the module global **four
awaits after resolving the tab**, one of which can inject a script twice and sleep, and two ordinary
paths set that global to `null`. A workspace closing in that window sent a command the page accepted
unconditionally. The CRM twin captured it on the first line and always had.

Checked now rather than written down: `the binding a command carries is read before anything awaits`
derives the capture position and the expectation's source in both products, and it was proven red by
moving the capture after the await.

## What else was real

- **The window lifecycle had four defects in forty lines.** No in-flight guard, so two clicks made
  two windows - and two windows restore the same directory handle, so two pulls can prune one mirror
  folder. `windows.update` rejecting was read as «the window is gone» rather than asked of
  `windows.get`. Remembered bounds were handed back to `windows.create` unchecked, so a window left
  on an undocked second monitor could open where nothing can reach it - a `popup` has no address bar
  to navigate with. And `windows.create` was outside every `try` under a `void` call, so a rejection
  left the product's one entry point dead and silent for ever.
- **A remembered split size was never re-clamped.** Dragged wide in a wide window and met in a
  narrow one, the detail pane put its own close mark and both «Open in Zoho» buttons outside a body
  that hides its overflow, with nothing in the panel that closes the pane. The pane was `flex:none`,
  so `min-width` could not help it; it may shrink now, the stored number is clamped on restore and
  on resize, and the drag stopped forgetting the 8px divider.
- **A drag released outside the window never ended.** No `mouseup` arrives out there, so the pane
  went on resizing under a cursor with no button held.
- **The folded chrome hid every control the empty states name.** Folded by default on a short
  screen, a first-run reader was told to press `+ Sample`, `+ Workspace` and `Pull all`, none of
  which was on screen - the «wrong missing thing» this project treats as worse than silence. The
  fold is a property of a *working* panel now and is not applied while there is no workspace open.
- **`tools/deadcode.py` went blind and printed a confident headline.** Its page sweep bailed on
  `"</style>" not in html`, and the day the last `<style>` block was lifted into a `.css` file that
  was true of all six pages: the step ran on **zero** of them while the headline counted scripts.
  It follows the linked sheets now and its headline counts pages and sheets. The same fix removed
  the false positives it would have produced (an id styled but not scripted; a class named in a
  comment about specificity) - and found three genuinely dead rules.

## The rules it left behind

1. **A surface that moves invalidates every assumption about where it was, and the list is a grep
   for the idiom, not a memory of the call sites.** Three independent readers found this class; the
   author, who had moved the panel that morning, had fixed one of six.
2. **A checker whose subject can be split across files must follow the split, and its headline must
   count what it opened.** «N scripts swept» said nothing about the pages, so the blindness was
   invisible. `csscheck` and `twincheck` already followed linked sheets; `deadcode` was the one that
   did not, and nothing compared them.
3. **A cache added to remove a cost is a global written after an await.** The tab memo was both, and
   `asynccheck` said so on the first run - the answer now records which workspace it was resolved
   for, and a named predicate is what makes the check readable to the tool.
4. **A sentence that describes where the reader is standing is a claim, and claims have to survive
   the product's own changes.** «This is a Zoho Analytics tab» was measurable from a side panel and
   is not from a window; it says «A Zoho Analytics tab is open», which is what is known.
