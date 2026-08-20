<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Nothing was cut: this is the same text,
     in the file CLAUDE.md now names. -->

# Repository layout

Zoost is becoming a family: one root brand, one repository, **one extension per Zoho product**.
They are separate extensions on purpose — different host permissions, a different single purpose for
the Web Store, a different data model — sharing only the name, the site and the philosophy.

```
apps/crm/        the Zoho CRM extension. Exactly what ships. Nothing else lives here.
apps/analytics/  the Zoho Analytics extension
site/            zoost.it — deployed by Cloudflare on push to main (root directory: site)
site/_worker.js  the Worker script (see the Cloudflare notes further down)
store/crm/       Chrome Web Store listing copy, permission justifications, release notes
store/analytics/ the same for the other product — both are published, and reviewed separately
docs/            these notes, opened when the area they cover is about to be touched
docs/findings/   one dated note per review of the codebase: what broke, what was done, and the
                 rule that stops it coming back. Named YYYY-MM-DD-what-it-was.md so they sort by
                 date and say what they were - never by the tool or the activity that produced
                 them, which is over the moment it ends
tools/           the checkers, the renderers and the release chain — everything derived or verified
tests/           node's own runner and Python's unittest; `bash tests/run.sh` is all of it
fixtures/        the sample org as data, and the graph fixtures the panel itself produces
dist/            build output, git-ignored
```

**This block named four of the repository's eight directories, and `store/crm/` alone described
itself as "per app".** Reported by the author, reading it. The twin rule and the enumeration trap are
both stated at length in this repository, and the map of the repository broke both - which is what
makes it worth a check rather than a correction: `tests/tools_test.py` derives the directory list
from disk, and from `apps/` and `store/` the per-product subdirectories, so the next one that appears
has to be named here or the suite says so.

Each app carries its **own `manifest.json` and its own version number** — they do not move in step.
`./build.sh crm` and `./build.sh analytics` package them separately.

**No code is shared between apps yet, and that is deliberate.** The two will look similar (a tree, a
preview, a health view, exports) but they read different platforms with different shapes. Factor
something out only once both sides actually use it and it has stopped changing — sharing too early
between two products that are still finding their form costs more than the duplication.

**But separate code must not mean separate products. The apps are twins, and it has to show.**
Technically independent, one product to whoever uses both. Anything they have in common — the
working-folder and workspace bar, the environment guard and its mismatch overlay, the dialogs, the
button semantics, the empty states, the wording, the colours, the philosophy — is **the same thing**
on both sides, down to the element ids. Two consequences, both binding:

- **Never invent what already exists.** Before building anything on one side, look at whether the
  other side already solved it, and port it. The Analytics panel shipped 0.2.0 with a working-folder
  picker invented from scratch: no Remove, no mismatch bar, no blocking overlay, no About dialog, an
  ad-hoc `.primary` class where the CRM has a five-class button grammar, and different ids for
  identical concepts. All of that was rework that need not have happened.
- **A change to something shared is a change on both sides.** Fixing the workspace bar in one app and
  not the other silently breaks the continuity for the person using both. If a shared change can only
  land on one side for now, say so explicitly rather than letting the two drift apart in silence.

Check it with the tool, not by memory, and **not by a checklist either**. A checklist only ever
contains the mistakes already made: this one grew a line after each of ten reported divergences and
was still incomplete every time, because the next drift was always in a dimension nobody had thought
to list. Run this instead — it compares the two panels rather than remembering to:

A class used but never defined renders as nothing, and nothing is hard to see. **And a rule
qualified by an element name is not a definition of the class**: `main td.k` styles `.k` on a `td`,
the four product pages each defined `.k` for their `<span>`s in their own inline block, and a fifth
page then used it with no rule at all - the span rendered as ordinary text while this check passed,
because `td.k` matched the pattern. Found by *measuring* in a browser (the span's computed style was
identical to its paragraph's), never by reading the stylesheet. The first fix reported every
`.nprod.ncrm` in the nav, which is a compound of two classes and does style it: «is the selector
qualified» was the wrong question, and «does it reach the elements that carry this class **on this
page**» is the right one - which the markup can be asked. `.k` now lives in `site.css` once instead
of in four inline copies. That check is now inside `sitecheck.py` (`classes_defined`), and the one-liner that used to live here is worth
recording as a failure: it concatenated `site.css` with **every** page's inline `<style>` and then
asked each page separately, so a class defined in one page's block read as defined on all of them —
which is exactly the defect it existed to catch. It printed nothing for months while `/how-to.html`
rendered its two product cards, and both guides their callouts, as unstyled paragraphs. `.card`,
`.cards`, `.note` and `.meta` now live in `site.css`, scoped to `main` so no landing page changes.
Per page, the CSS is `site.css` plus that page's own block, and the class name must end at a
boundary — the substring test counted `.cards` as a definition of `.card`.

The site has its own version of the same problem and its own checker. The navigation grew a
different *shape* on two of six pages — a `<span>` holding two sub-links where the rest had one
`<a>` — and a bar that changes as you move through a site is disorienting in a way that is easy to
notice and hard to name. It was reported by the user, which is the failure. **A contextual
*target* is fine and invisible; a contextual *shape* is not.**

**No date a reader can see is typed, anywhere.** The argument is the author's and it is the general
form of everything else here: a date written into a file is unverifiable by construction and free to
disagree with the record it claims to describe - *«I could, absurdly, type in a date different from the
one on record»*. Every system involved already holds its own: **GitHub** timestamps every commit
and tag, **Google** reports the state of a submission, **Cloudflare** reports when the site went live.
So `tools/stamp.py` *writes* the version and date on every page - the version from the app's
`manifest.json`, the date from the last commit touching the page - and `sitecheck.py` reports a date
anywhere in outward prose that is not inside a `data-stamp` element. The criterion is structural, not
a list of permitted values: declaring a stamp is done where it lives, forgetting is reported.

Three consequences worth keeping. **`RELEASES.md` lost its Submitted column**, because that is the
one date no system holds - the Store API reports which state a revision is in and never when it
entered it - so it could only ever have been a number I typed; the tag is timestamped by GitHub and
the state is on `zoost.it`, from Google. **A translation is dated by its original**, read from the
`translated-from` marker it already carries, which is also what the runtime does, so the two cannot
disagree. And **editing a page bumps its date**, including the privacy policy's, since git is being
asked when the file changed and it did - which over-reports rather than under-reports, and that is
the safe direction for a document a reader is meant to re-read.

The first version of that check stripped four-space-indented lines as Markdown code and applied it to
HTML too, where nearly every line is indented: it blanked most of every page and reported **zero
across the whole site**. Found by mutating a page and getting nothing back. A checker that goes quiet
is the failure this file keeps naming, and the only way to know is to break the thing on purpose.

```bash
python3 tools/sitecheck.py           # header and footer must have one shape across all pages
python3 tools/stamp.py               # write the dates and versions the pages print
python3 tools/stamp.py --check       # ...and report them if they have drifted (the suite runs this)
python3 tools/namecheck.py           # no shipped file may name, link to or identify as the other product
python3 tools/featurecheck.py        # every control a panel offers must be named somewhere on the site
python3 tools/sitemap.py --check     # the sitemap is derived from the site, never typed
python3 tools/notescheck.py          # how much room CLAUDE.md has left, printed whether or not it is short
```

**The last one exists because the notes themselves failed the way everything else here can.**
CLAUDE.md reached **280,013 characters against a limit of 150,000**, so nearly half of it was not
read and nobody could say which half - and the part worth keeping is that it did not stop at the
limit, it went on to nearly double it. Nothing measured, so there was no signal at any point along
the way; it was reported by Claude Code itself, on the first session opened on another machine.

There *was* a test, and it was worse than none: `test_it_is_under_the_limit_with_room` asserted
`< 150_000`, which is the limit itself. Under that name it would have gone red at the moment content
had already been dropped in silence - no room, and a name that said otherwise. The budget is now
**100,000, two thirds of the limit**, because the remedy is not a one-line fix: a topic has to be
lifted into a note, given an index row that says when to open it, and left readable in both places.
A gate has to fire while there is time to do that with judgement. A second case holds the budget
under three quarters of the limit, so the tempting fix - raise the number until the run goes green -
puts the check back where it was and is caught. And the figure is **printed on every run even when
nothing is wrong**, because a threshold that speaks only when breached says nothing about the
direction of travel, and this file grows by about a thousand characters each time it is touched.

`docs/*.md` is measured and deliberately not judged: those are read on demand rather than loaded into
every session, so there is no limit to breach - only the cost of a long read, which is the author's to
weigh. An empty one *is* a finding, because the index promises it.

**A URL is what the platform serves, not what the file is called, and every check here derived it
from the file.** Cloudflare serves `crm.html` at `/crm` and 307s the `.html` form to it, so each page
declared a canonical pointing at a redirect while `/crm` — the URL that answers 200 — announced
itself as an alternative of it. Google indexed **neither**: Search Console reported «alternative page
with proper canonical tag» and the product pages were invisible for as long as they had existed. The
site was internally consistent the whole time, which is why nothing caught it; `auditcheck.py` had
the right rule in `published_path()` and `sitecheck.py` had a different one four files away, and
nobody had ever compared the two. `canonicals_answer_without_redirecting()` now asks the site rather
than the repository: every canonical and alternate must answer **200 with no redirect**.

**And the sitemap was hand-typed, which is the same defect with a slower fuse.** Its `lastmod` had
drifted three days behind on 15 of 17 URLs and two carried none at all — at the exact moment the
canonical fix had rewritten every page and we needed a recrawl. Google's documentation is explicit
that it uses `<lastmod>` *"if it's consistently and verifiably accurate"*, so dates that fail that
comparison cost the field across the whole file, not one row. `tools/sitemap.py` derives all of it —
URL by the served rule, `lastmod` from the last commit touching that file, the `hreflang` pair from
whether the translation exists — and writes **no `<priority>` or `<changefreq>`, because Google says
plainly it ignores both** and a hand-maintained field nobody reads can only ever be wrong.

**The sample workspace is an argument, and it was documented as a feature.** «+ Sample» writes a
workspace of invented data, and what that buys is not convenience: it is the only way to answer «what
does this thing do» *before* giving it something to read. Usually the order is reversed - install,
grant access to the org, then find out. **`/try.html`** (and `it/try.html`) makes that the page's
subject: what each sample actually contains, counted rather than described; why nothing reaches the
platform (`guardOk()`, one place, and `sample: true` as the whole mechanism); what an approver can
settle without risk; and - the part that makes the rest credible - **what it does not prove**, since
an invented org shows the product's full complexity and says nothing about its scale. It is in the
nav on every page, in both languages, because burying it in the guides would put it where only
someone already convinced would look. The counts in it are read from the shipped generator, so they
cannot drift into decoration.

**And a table of counts invites addition, so the counts have to add up.** It listed 120 functions,
18 modules, 10 workflows, 7 schedules and 6 connections under a heading saying **293 files** - and
those five make 161, because they count *objects* while the heading counts *files*. Reported: a
reader who lacks the detail concludes the arithmetic is broken. The middle column is the file count
now (241, 38, 11, 1, 1, plus `.zoost.json`), which sums to the heading exactly, and the third says
why - a function is two files plus an index, a schedule is a row *inside* an index and no file at
all. That is the shape of the mirror, and the page that invites you to go and look at it is the
right place to teach it. Every figure comes from running the shipped generator.

**The labelling script assumed a `<th>` row is a column header, and on those two tables it was a
caption.** So the stacked view read «ZOOST CRM: 120» and «293 FILE: funzioni Deluge» - a label taken
from the wrong axis. They carry real column headers now and the caption is an `<h3>` above the
table, which is what it always was.

**The AI had no page, and a subject mentioned in eleven places and owned by none is a subject the
reader has to assemble.** `/ai.html` (and `it/ai.html`) states the position rather than the feature
list, and the position is deliberately smaller than the hype: **the workbench is finished without a
model**, said first and not last; the **Markdown export** hands any external assistant the same
mirror for nothing, and for a mid-sized org that is the better route - bigger model, real chat
window, no key; the **built-in assistant buys retrieval and proximity, not knowledge**, because it
is given a vocabulary and nine tools that read the mirror instead of being handed the org. A table
says which situations do *not* justify a key, which is the part that makes the rest believable.

Two absolutes were written and caught before shipping, by reading the ledger rather than by
instinct. «There is nothing it can tell you that is not already in the mirror» is false - the model
contributes its own reasoning - and the true claim is about *facts about your org*, which is what it
says now. And «the one control that cannot be got wrong» about a spending limit is rhetoric: a limit
can be set badly, what it cannot do is depend on an estimate.

**«Why your own key» is a trust argument and was missing from the site entirely.** There is no Zoost
server, so the request goes browser to provider; the alternative is a relay the author runs, holding
a key, with the structure of the user's org crossing it. The header Anthropic requires for a
browser call - `anthropic-dangerous-direct-browser-access: true` - is quoted on the page rather than
hidden, because its name is a fair warning and what it warns about is precisely the property being
chosen.

**The nav pill is amber because the panel's AI button is** (`.abtn`, the same three colours), and it
is an outline where the two products are filled - a subject that crosses both is not a third
product. It sits on the products' row, and *that* was decided by measuring: on the second row the
Italian nav came up **5.3px short** at 375px and orphaned the language switch, which is the accident
this file already records. Below 360px the declared break is dropped and the bar wraps freely -
better at 280, 320, 340 and 359 in both languages than keeping it. What remains is stated rather
than chased: at 320px in English the switch still lands alone, because five short labels fit above
it and the sixth does not.

**«Your org» was the whole framing, and it left out the reader who needs the tool most.** A
consultant works on orgs that are not theirs - which is exactly why keeping four clients mirrored,
each bound to its own org, host and instance, matters more to them than to anyone. The capability
had been there since the beginning and was **named only in `README.md` and in the CRM store
listing**: on `zoost.it` the words «consultant» and «more than one org» did not appear at all. The
enumeration trap in its worst form, because the surface that was missing it is the one that sells,
and the audience that was missing is the one with the strongest need. Both product pages and the
home now carry it, and the environment guard is stated as what it is for that reader: not a
precaution but the reason several clients can be open at once without one being pulled into
another's mirror.

**There is a third reader, and the site had no page for them: whoever has to *approve* the install.**
The IT lead, the DPO, the manager who receives «can I install an extension that reads the CRM?».
Everything they need was already written - read-only, no server, which permissions, reproducible
builds - and spread across five pages in a peer-to-peer developer voice. «If you have to approve it»
on the home is six rows of table, no jargon, and it is the single addition with the most commercial
value the site has had.

**The voice has a tic, and it is visible at scale.** «X, never Y» - «Numbers, never verdicts»,
«Candidates, never a verdict», «Counts and lists, no scores», «Certain, or stopped», «Read-only, on
purpose», «Checkable, not just claimed» - 29 of them across eleven pages, plus the reflex of
answering an objection nobody made («It computes; it does not create») and four «no»s in five lines.
Each is good; together the reader stops hearing the content and hears the formula, and the formula
reads as machine-written on a site whose whole argument is that a person is accountable for it. Break
some: a long sentence, a claim left standing without its counterweight, a heading that is just a
noun. And **say «I», never «we»** - «the trade is yours, not ours» sat two paragraphs from «built by
one person»; the one-man-shop position is the asset and the plural quietly denies it.

**A promise repeated past a certain count starts to sound insisted on.** «It only reads» was on the
home three times; twice is the maximum and one of those should be where it decides something.

**The product pages are for someone deciding, not for someone auditing.** They were 2000 words each
and read as a specification — «nobody will ever read all that text; it needs highlights, not
Wikipedia», which was right. What a reader needs first is what it does for them; what it rests on,
which endpoints it calls, what a CSRF prefix is and how a release is signed is a different question
asked by a different person on a different day. That material moved to **`/nerd.html`** (and
`it/nerd.html`), which is linked from every product page and from `llms.txt`, and where being
exhaustive is the correct register rather than a failure of nerve. The product pages are ~850 words;
the home is ~630.

**A demonstrative that carries an English headline dangles in Italian.** «Hundreds of views, and no
way to see the shape of them. *This* draws you the map» works in English, where a bare `this` can
point at the product you are looking at. Italian inflects it for gender, so «Questa ti disegna la
mappa» goes looking for a feminine noun and finds *la forma* - which is the thing being complained
about. Reported by the author. The subject is named on both sides now, which is the same rule as the
one below, and the general form is: **a construction that leans on deixis in one language has to be
re-anchored in the other, not translated.**

**A headline needs its subject in it.** «You built it. It is yours. / And the platform gives you no
way to see it whole» — built *what*, on *what* platform? The reader works it out from the paragraph
below, which is one paragraph too late. It names Zoho and it names the things now.

**The site may keep a technical register; it may not be incomplete.** The test it has to survive is a
real one: hand `zoost.it` to an assistant, ask what the product does and whether it is trustworthy,
and see whether the answer matches the software. A capability that exists in the panel and is
described nowhere makes that answer wrong by omission, so `featurecheck.py` compares the panels'
control labels against the pages. It cannot judge whether the prose is good — nothing can — only that
nothing is missing. **`site/llms.txt` is the map that assessment starts from**: what the products are,
what they refuse to do, where each claim is verified, and what none of it proves. It is listed in
`robots.txt` and the sitemap, and it is checked by `sitecheck.py` like any other outward prose,
because it makes claims.

**And run them without being asked.** The user should not be the one noticing that a guide describes
a button the panel stopped drawing, or that a short description repeats the item name it sits under.
Both of those reached him, and neither was a lapse of attention that more attention would have fixed:
each was a dimension nothing measured. `featurecheck.py` now compares the panel's *marks* against what
the guide draws, not only what it names — and its **filter and sort dropdowns**, which it could not
see at all: it read `<button>` elements in `sidepanel.html`, while those menus are built in JS from
literal pairs inside `buildTypeChips()`. Every choice in them is a capability with a name, and
`Has scheduled actions` shipped past the check without the site knowing the feature existed, and `auditcheck.py` reports a description that borrows three
consecutive words from its own item name. The rule is the one already here — **extend the check, never
the care** — and the corollary is that the battery is run at every checkpoint, by me, unprompted:
`tests/run.sh`, then `auditcheck.py`, then `reachcheck.sh` when the site moved.

**Run all three before calling a change done.** They divide the problem three ways and each was
written after something got past the others. The third exists because of a pattern worth naming:
five naming defects reached the user, and all five were invisible for the same two reasons.
`twincheck` reads **two files out of the twelve each app ships**, with the pair written by hand —
a checklist wearing a script's clothes, inside the tool built to prevent exactly that. And every
check compared *structure* — ids, classes, declarations, handlers — while a product name is a
**string**, which nothing read.

So `namecheck.py` globs (a file added tomorrow is covered without anyone remembering) and reads
strings: every shipped page's `<title>` must name its own product; no file may name or link to the
other one; the manifest's identity fields are the authority rather than a copy kept in the tool; and
it reads `release.yml`, because "Zoost for crm 1.9.0" was published by the one file that is neither
panel nor page. Proven against all four defects: each is reported when reintroduced.

**When a check misses something, extend the check — never the care.** "Be more careful" had already
been tried five times.

```bash
python3 tools/twincheck.py          # shared chrome: ids, classes, inline styles, CSS declarations
python3 tools/twincheck.py --all    # everything, product-specific parts included
```

**And a fourth, for the one thing none of the three can see: a call to a function that is not in the
page.** `pruneSql()` in the Analytics panel enumerated the workspace with `walk()`, which is a *CRM*
panel function and has never existed on the Analytics side - the line was written from the CRM side,
which is what the twin rule makes likely rather than unlikely. Nothing here caught it: `node --check`
accepts a free variable, `twincheck` compares functions that exist on both sides and this one existed
on neither page, the panels are not importable so no unit test runs it, and the probe drives the
sample workspace, where no pull happens. It threw inside the one `try` block that marks the mirror
incomplete, so a pull that had written every one of its bytes correctly ended as «the last pull was
interrupted mid-write - run Pull all to repair», and the repair hit the same wall. **It is in Zoho
Analytics 1.28.0, the package Google was reviewing when this was found** - the Store was still serving
1.27.0, which does not contain it. Nobody was affected, and the margin was one review queue: it was
found by a sweep rather than by any of the gates.

```bash
python3 tools/callcheck.py          # every function a page calls must be in one of the scripts it loads
```

One page is one scope, which is what a browser does with classic scripts, so the check is per page
and not per file. Its limits are in its docstring rather than left to be met: it is file-scoped and
not block-scoped, it reads *calls* and not every free variable, and the globals it accepts are a list
- so a platform API nobody here has used yet is a false finding and one line to add. It reports zero
on this tree, which is what makes it a gate rather than a ledger.

**The duplication between the two products is not removed, it is held - `tools/twins.txt`.** 66 of
the 138 function names both apps define are **byte-identical**, 26,247 characters of deliberate copy:
`settle()`, `erLayout`, `aiStreamAnthropic`, `wireAsideFold`, `mergeKeys`, `syncLockRow`. The decision
above still stands - and the bill for it has already been paid once, when the force layout was
rewritten and `settle()` was carried across by hand, arriving because somebody remembered. Merging
them is refused for a reason that beats the tidiness argument: the extensions are developed **loaded
unpacked**, so a `shared/` folder assembled by `build.sh` would exist in the package and not in the
tree being tested - a real regression bought with a theoretical gain.

So `twincheck` records every twin function with a hash of each side's body and reports a **one-sided
change**, which is what "fixed on one twin and not the other" looks like from the outside. It is a
ledger, not an allow-list: nothing is named by hand, a function that becomes a twin tomorrow is
recorded without anyone remembering, and `--accept` acknowledges the current state after it has been
read - the same differential shape as `tools/absolutes.txt`.

**Being *behind* is a finding too, and that is the part that makes it work.** A pair that moved on
both sides honoured the twin rule, so it is not a drift - but leaving it unrecorded means the next
one-sided change is measured against a state two commits old, reads as having moved on both sides,
and passes. Silence exactly where the check is supposed to speak. Proven against all three cases:
change `settle()` in one app (reported), in both (ledger behind), rename it on one side (no longer a
twin). Note *why* the first mutation had to be a real statement - inserting a comment changed
nothing, because the extractor strips comments before hashing, which is correct and made a careless
proof pass.

**And it exits 1 now.** Its four siblings always did; this one returned 0, so `tests/run.sh` ran it
and could not fail on it. Invisible while it printed zero, and it would have stayed invisible exactly
when it stopped.

**The lists inside it are of what is deliberately different, never of what to check.** That
direction is the whole point: forgetting to declare something makes it *reported*, not silent. Two
earlier versions had it the other way round and both went quiet on real bugs — one because the rule
styling a button existed on a single side, the other because nobody had added the resizer to a list
of things worth comparing. An allow-list is a checklist wearing a script's clothes.

Where a criterion can be derived, it is: the set of shared classes comes from reading both files'
markup, not from a list, so a class used on both sides but styled on one is always reported. A rule
is anchored on the first class or id of its first token — `.dtab.active` is about `.dtab`, not about
`.active`.

It also compares **behaviour**, because markup and CSS can match perfectly while a control does
nothing on one side — the dimension that let the detail pane keep its scroll position when the CRM's
resets. Two checks, both approximations and honest about it: which shared controls have a handler and
of what event type, and which platform and DOM techniques each panel uses *at all*. What a handler
*does* is not statically comparable, so the second is a smell detector at file granularity: it would
have caught the missing scroll reset, and would not have caught the search box failing to take focus
back, because that file used `focus` elsewhere.

**Prove it against a bug you already know about before trusting it.** Removing `.aiinrow #aisend`
from Analytics must make the tool print three findings; putting it back must return it to zero. A
checker that has never caught anything is a claim, not a check — and claiming otherwise is how this
took three attempts instead of one. It decides nothing — a difference may be deliberate.
**It must print zero unexplained differences before a UI change is done.** Anything genuinely
deliberate goes in its `EXPECTED` map *with the reason on the same line*; a checker that keeps
reporting known-good noise is a checker nobody reads.

Walk each difference and decide: is it genuinely product-specific (functions, modules and Deluge
exist only in CRM; views, query tables and the ER model only in Analytics), or is it shared chrome
that has drifted? Only the first kind is allowed to differ.

**The accent is the one deliberate exception, and everything derived from it follows.** `--sel` is
`#2563eb` in CRM and `#dc2d7a` in Analytics — each panel's own icon colour, so the app you are in
says so without a label. `--sel-soft`, `.zbtn`, `.znav` and the user's chat bubble derive from it and
are expected to differ; they are declared in `twincheck.py` with that reason. Nothing else may.

**A hue is a claim about a dimension, and a hardcoded one is a claim about nothing.** The focus chip
shipped with an authored amber, which said nothing and sat a few pixels from the Connections chip in
the same amber. It takes the focused item's **own** category colour now, through the same accessor
the list dots and the filter chips use — so «what am I focused on» and «what kind is it» are one
glance — and carries no hue at all when nothing is selected, because then there is no category. Same
mistake as the dot that was coloured by namespace while the chips filtered on category, one dimension
over.

**And the hashed fallback was not enough on its own.** It gave `scheduler` and `custombutton` the
same violet: two roles, one colour, which is the defect the rule below is about. The hash now chooses
a *preferred* slot and the first free one from there wins, so the answer depends on the whole set of
kinds present and every one of them is distinct. Still deterministic — the same workspace always
draws the same colours — and a kind only moves when a new one lands on the slot it wanted. Past eight
kinds a repeat is unavoidable and is not hidden.

**Five roles, five hues — check the accent has not eaten one.** The button grammar needs the accent
to be distinct from `.lbtn` teal, `.pbtn` violet and `.abtn` amber. Analytics ran with a teal accent
for a while and `.lbtn` collided with it: two roles, one colour, and one fewer distinguishable
meaning than the CRM had. A new product's accent has to clear those three before anything else.

**That grep only covers markup. The twin rule covers behaviour and artefacts too**, and that is
where it was broken next: exports were written to `export/` in CRM and to the workspace root in
Analytics, under a different filename shape and a different timestamp format. Nothing in the markup
could have caught it. So also compare, by reading both sides:

- **what an overlay covers.** In the CRM panel `#aiview` and `#healthview` live inside `#belowbar`
  at `inset:0`, so opening one hides the mode segments and the per-type button row beneath it — the
  view owns everything below the main toolbar. An overlay that starts lower leaves a strip of stale
  controls visible and looks like a different product.
- **a control that has nothing to do is absent, not disabled.** The CRM's "Complete missing" button
  is `display:none` until there is something missing, and its label carries the count. A greyed
  button still says "there is something here you cannot have", which is misleading when there is no
  something. Disabled is for *temporarily* unavailable — wrong workspace, pull running.
- **what a symbol means.** The glyphs are a vocabulary shared across the apps, and one that means
  two different things is worse than none: **`↻` is local** — "reload from disk / re-grant folder
  access" — and **anything that reads from Zoho says "Pull"** and wears `.zbtn`, whether it is
  "Pull all", the per-type "Pull", or the per-item one. The Analytics detail pane shipped a `↻` that
  called Zoho; it was the right colour and the wrong glyph, which is the confusing combination.
  **A mark may replace the visible word, and never the name.** The toolbar's `Pull all`, `Pull` and the
  diagram button are inline SVG in `.mk` — 1.6px stroke at 13px, `currentColor`, so each inherits its
  button's role colour instead of introducing a sixth. The rule above still holds, with the emphasis
  moved: anything that reads from Zoho is still *called* Pull and still wears `.zbtn`; the name lives
  in `aria-label` and `title`, which is where a name has to be for anyone not looking at pixels. Two
  down arrows mean **all** — adding the word beside them was saying it twice.
  This cost coverage the moment it landed: `featurecheck.py` read visible text, so three controls went
  from checked to invisible without a word. It reads `aria-label` first now, and the first thing it did
  was find two controls the site had never named.
  **A glyph that merely *resembles* another is the same defect.** The AI chat's Clear wore `↺`, which
  differs from `↻` only in the direction of an arrow, at 11px, a few pixels from the real Refresh.
  It lost the glyph rather than gaining a new one: the label already says Clear, and the vocabulary is
  better one symbol smaller than one ambiguity larger.
- **where a file is written and what it is called** — `export/zoost-<name>-<stamp>.<ext>`, with
  `stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')` and `sanitize()` on the name
- **what the status line says afterwards**, word for word
- **which guards run before an action** — e.g. `ensurePerm(dir)` before writing an export
- **which folders a workspace walk skips** (`modules/`, `export/`)

An export is the artefact a user collects from both apps. Finding it in a different place in one of
them is exactly the discontinuity these two are supposed to avoid.

`LICENSE`, `NOTICE` and `README.md` live at the root so GitHub picks them up; `build.sh` copies
the first two into the package at build time.
