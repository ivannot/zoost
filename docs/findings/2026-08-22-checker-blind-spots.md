# Findings - 22 August 2026, the second half of the whole-tree scan

The queue left open by the sweep of 20 August, taken to the end. Nine defects, and they fall into two
groups that turn out to be one: **four checkers reported zero over surfaces they never read**, and
**four fast paths quietly decided what a reader got**. Both are the same shape - a mechanism that
answers a narrower question than the one it appears to answer, and says nothing about the difference.

Everything below was verified here before it was changed, and every fix has a test that was proven to
go red on the defect it names.

## 1. The summary cache decided nobody got the source code - high

**What broke.** `loadGraph()` put `source_code` on every graph node. A node served from
`functions/meta-index.json` carries the references and the counts and an **empty string** - that is
the whole point of the cache, 60,015 file-system calls down to 8 - and after the first pull every node
is served from it. Four readers took the field at its word: `search_code` answered «(no matches)» over
an org whose source it had never opened, `get_function` returned a function with everything but its
body, the CURRENT FOCUS block handed the model an empty fence, and the Markdown export wrote
` ```deluge ` with nothing between the fences.

**The fix.** The field is gone from the node. `fnSource(n, op)` reads the file at the moment the
question is asked, once per node, with a count of what could not be read - which is exactly what the
Analytics twin already did after `search_sql` was found never to have run once.

**The rule.** **A cache may make an answer cheaper and may not make it different.** Where a fast path
drops a field, the field has to stop existing, not become empty: an empty string is indistinguishable
from a true absence at every call site, and it was indistinguishable at four of them for months.

The first version of the test for this was worthless in a way worth recording: `!n.source_code` is
true of the defect and of the fix alike, because the defect *was* an empty string. It reads
`'source_code' in n`, and the old line planted back turns it red.

## 2. Two reports of one workspace counted different orgs - high

**What broke.** The HTML export enumerates `functions/index.json` - every function the org has - and
marks what a pull could not download. The Markdown enumerated the call graph, which is built by
walking the `.dg` files, so it listed the downloaded ones and printed their number as the org's
function count. The report that undercounted is the one written to be handed to an assistant.

**The fix.** Both enumerate the index. The join that pairs each index row with its graph node already
existed four lines above, under a comment saying the two reports must not be able to disagree; it
carried one field.

**The rule.** «Not read» and «does not exist» are two facts, and a report that cannot tell them apart
is worse than one that omits them both - the reader cannot know what they are missing. Third instance
in this repository: the Analytics query tables, the connection usage shown as zero, and now this.

## 3. A grep scoped to a file name outlived the refactor that moved the code - medium

**What broke.** The diagram window's source panel has drawn nothing since 14 August. The payload
handed to that window stopped carrying `source_code` - the whole org's text was crossing into storage
for a card showing a few dozen lines - and the commit that did it recorded «`source_code` appears
nowhere in either graphview.js, so it was pure carriage». True of `graphview.js`, and a day out of
date: the renderer had moved into `graphlogic.js` the commit before.

**The fix.** Removed rather than restored. The strip was right, both privacy pages describe the
smaller payload, and source is read in the side panel, which holds the folder. Its two CSS rules and
the `highlight.js` the CRM graph window loaded for that one call went with it.

**The rule.** **A grep scoped to a file supports one claim: about that file.** Any refactor that moved
code invalidates it silently, and «I checked» is what it feels like from the inside. Verify the
behaviour, or grep the tree.

Removing the styling I dropped `.srcwrap` and `.srchead`, still emitted by four other renderers in
each window - the same rule, five minutes later, in the other direction.

## 4. Four checkers, one shape: zero over what they never opened - high

| checker | read | of | what was invisible |
|---|---|---|---|
| `csscheck` | 1318 | 1487 | a rule whose body spans lines (dropped whole); two rules on one line (the second never seen, the first's body wrong) |
| `featurecheck` | 78 | 161 | `options.html`, `graphview.html`, and every control built in a script |
| `samplecheck` | 15 claims | 15 + 13 | the whole **Files** column - already measured, never compared |
| `htmlcheck` | 148 | 210 | fixed 21 August; the precedent all three follow |

**The fix, and it is one fix.** Each careful pass now has a **second, cruder pass over the same
subject, compared by position**: every `{`, every `<button`, every row of the table must fall on
something the careful pass read or inside a span it can say it skipped. A position it cannot account
for is a finding **about the tool**, printed above any finding about the code, and the headline says
«1477 rule(s) read … none left unread» rather than a count of what it happened to look at.

**The rule.** **A count of findings is meaningless without a count of what was examined**, and the
tool is the only thing that can report the second. Where the two can be compared by position rather
than by number, compare them: a crude count is either short or long and neither says whether the same
ground was covered.

What the widenings found, none of it visible before: `.wfcrit i` written twice in one file; `button`
and `.ftbl tr:hover` meaning two things per product (deliberate, ledgered); the Analytics diagram
window offering **`Emphasis: modules`** in the one product that has no modules; and four capabilities
described nowhere on the site - per-rule executions, the layout `View ↗`, the Analytics ER toggles,
and the settings-conflict box that asks whether to keep your edit or take the other window's.

## 5. A queue per function, and nothing at all per burst - medium

**What broke.** `syncOne` holds one read per id and one more after it. Fifty notices for fifty
functions started fifty reads, fifty authenticated requests and fifty writes at once. A deploy that
saves thirty functions reaches that honestly; the page's MAIN world can reach it deliberately, since
the bridge holds the id to twenty digits and says nothing about how many arrive.

**The fix.** Four at a time, queued, nothing dropped - dropping would break the honest case, which is
the one worth protecting.

**The rule.** **A guard against duplication is not a guard against volume.** They read alike in prose
and are different code; when one is written, ask out loud whether the other exists.

## 6. The one surface that would not let you reach the six that were careful - medium

**What broke.** A query table whose SQL a pull could not fetch is stated on six surfaces, with a test
enumerating all six. The seventh was the tab: `$('tab_sql').disabled = !sqls[id]` put «not a query
table» and «its SQL could not be read» under one grey control with no title, so the reader never
arrived at any of the six careful sentences.

**The fix.** It asks `sqlState()` like everything else, and the pane gives the reason Zoho or the disk
gave. Relations and Lineage carry a title saying why they are off, which the ER button two lines above
has had since it was written.

**The rule.** **A list of surfaces is only as good as its length**, and nothing measures that. When a
test enumerates places, the enumeration is the thing to attack: walk the product looking for the one
that is not in it.

## Said rather than fixed

- **`csscheck` cannot read a stylesheet inside a template literal**, which is where the HTML export's
  is. That export used `class="note"` and defined it nowhere - the fifth time a class in this
  repository has rendered as nothing - and the fix is in the file, not in the checker: teaching it to
  read CSS out of JavaScript would be a tool auditing a surface with one user.
- **`featurecheck` cannot see a button assembled by `createElement`** and given its label by a
  variable. Its docstring says so now; the coverage audit only claims to account for `<button` as
  written.
- **The Analytics `erEmph` state is still the string `modules`.** It is the key saved layout
  parameters are written under in every user's browser, so renaming it is a migration rather than a
  label change. Only what the reader sees was corrected, and the code says why.
