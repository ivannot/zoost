<!-- Moved out of CLAUDE.md, which was 280k against a 150k limit - so half of it was not
     being read, and nobody could say which half. Nothing was cut: this is the same text,
     in the file CLAUDE.md now names. -->

# Naming and positioning

The products are **Zoost - workbench for Zoho CRM** and **Zoost - workbench for Zoho Analytics**.
Not "IDE": you do not edit code in them, and the audience is wider than developers. "Zoho",
"Zoho CRM", "Zoho Analytics" and "Deluge" appear only in a descriptive position, never as the
leading element of the name, and never in the icon. Every user-facing surface carries the
independent/unofficial disclaimer.

**The generic URL may not belong to one product.** `/docs` was the Zoho CRM guide while Analytics
carried its name in the path — the same asymmetry as the navigation, one layer down. The guides are
`/docs-crm.html` and `/docs-analytics.html`, and `/how-to.html` is the neutral way in that the
horizontal pages link to. `/docs` and `/docs.html` **301 permanently** to the CRM guide and must
never stop doing so: Zoost for Zoho CRM 1.9.0 has that URL compiled into it, and a published
extension cannot be asked to change. The redirect lives in `_worker.js`, since assets are served
first and a file at that path would win.

**The site is translated page by page, and a translation that falls behind is reported, not
remembered.** `site/it/` holds the Italian pages. Each one carries
`<!-- translated-from: site/<page>.html @ <sha> -->`, and `sitecheck.py` compares that sha against the
English page's last commit — so forgetting to update the Italian makes it **reported**, which is the
only direction that fails safe. The marker lives in the file rather than a side table, so whoever
copies the page carries it with them.

The marker is a digest of the **content**, not of the commit that last touched it. The first version
used the commit and was wrong in a way only using it revealed: editing an English page and its
translation in one change leaves the marker naming the commit *before* that change, so the check fires
on a translation that is perfectly current and cannot be satisfied until a second commit exists.

Four consequences, all deliberate. The **chrome is one shape per language**, not one shape overall:
it must not change as you move through a site, and it must change when you change language, because
the labels are the point. The **naming rules apply in Italian too** — a bare «Analytics» says exactly
as little about whose product it is. And the **UI control names stay in English**, because the
extension is: a guide that says *premi **Pull all*** is naming the button the reader will actually
find, and the Italian page says so in a line under the hero rather than leaving it to be discovered.

The **version badge is the one thing on a page written by script**, so a translated page cannot
translate it by itself: `site.js` carries a small string table keyed on `<html lang>`, with English as
the fallback for anything unlisted — a missing key shows English, never a key.

**Everything is translated except `llms.txt`.** `index`, `crm`, `analytics`, `how-to`, `nerd`, both
guides and `privacy.html` have Italian versions; `llms.txt` stays English because it is read by a
machine and one version cannot disagree with itself. That is stated on the page rather than left to
be noticed.

**The privacy policy is translated, and the English one governs.** It was kept English-only on the
argument that a second wording is a second thing that can be argued about - which is real, and is
answered by saying which one wins rather than by leaving Italian readers without it. The `.it` domain,
the Italian site and an Italian reader who has to *approve* the extension inside a company all point
the same way: `it/privacy.html` opens with a `data-it-only` note naming the English page as
authoritative. Translate it literally; the register is dry on purpose and the numbering is the same on
both, so the two can be read side by side. **The control names inside a guide stay in English**, because the panel is —
a guide that says *premi Scarica tutto* names a button the reader will never find — and the note
under each guide's title says so.

**English is the version of record; Italian is where the defects are found.** The footer says the
English governs, and it does - but the author reads the site in Italian, so that is the language a
problem surfaces in, and «fix it where you saw it» leaves the authoritative version behind while
every check stays green. `translations_current()` only ever sees the other direction: the English
moved and the Italian did not. So the rule is **fix the English first, then carry it over**, and
`translations_have_the_same_shape()` makes the opposite case reported - the two languages must hold
the same number of content blocks once anything marked `data-it-only` is removed. Counting blocks is
an approximation and says so: it will not see a paragraph rewritten in one language only, it will see
one added or removed, which is what a correction usually looks like.

**A translation is structurally its original, and that is what makes it checkable.** Same sections,
same paragraphs, same order, so blocks pair up by position. `shared_prose_stays_shared()` uses that
to enforce the twin rule one layer down: prose identical on `crm.html` and `analytics.html` must stay
identical on `it/crm.html` and `it/analytics.html`. Eleven of twenty had drifted — «leggi ciò che
viene spedito» against «leggi quello che viene distribuito», «un passo manuale» against «un passaggio
manuale». Nothing was *wrong* in either, which is the point: a reader moving between the two pages
meets the same sentence twice in two voices, and the twins stop reading as twins.

Where a translation legitimately adds something — the note saying the control names stay in English —
the element carries **`data-it-only`**. Forgetting to declare an addition makes the page reported,
never silently exempt, which is the direction every allow-list here runs in.

**The first version of that check counted shared blocks per pair, and it was useless.** The Italian
pages happened to share one block the English ones did not, and that single spare was exactly enough
slack to swallow a real drift when one was reintroduced on purpose. It is kept as a test case. The
rule it proves is the one already in this file: *a checker that goes quiet on the bug it was written
for is worse than none* — and the only way to know is to break the thing deliberately.

**The language switch is on every page of both languages, and its target is contextual.** A control
that appears and disappears as you move through a site is the contextual *shape* this file already
bans, so pages with no translation still carry it, pointing at the other language's home with a
tooltip saying why. It reuses `.ncta`, which was defined in `site.css` and used nowhere.

**An Italian page links Italian, or says why with `hreflang="en"`.** The Italian home's two
«Come si usa →» links opened the *English* guides — reported by the user, and invisible to every
check here, which read prose and chrome and never an `href`.
`translations_link_to_translations()` reports a link to a page that has a translation unless the
element declares `hreflang="en"`, which is what that attribute is for; the deliberate ones — the
switch, «la versione inglese di questa pagina» — all carry it now.

**Two of those links had been fixed and then thrown away by `git checkout <file>`**, used to undo a
deliberate mutation while proving a *different* checker. It reverted the real, uncommitted work
sitting in the same file, and nothing noticed — the page then went out linking the English guide
*and* claiming the guide was English-only. Undo a test mutation from a copy (`cp` the file aside
first), never from the index, unless the file is known to be clean.

**A translation is reviewed for its Italian, not only for its faithfulness.** A pass over all six
pages found about forty defects that no check could see: «legge la tua org vero» (a masculine
adjective postposed to a feminine noun, which is what the user reported); «La colonna References
*sono* le chiavi esterne»; «quello che *serve*» for "what it serves", inverting the sentence;
«i campi presenti in **nessun** layout» and «tabelle in nessuna relazione», a bare negative
determiner with no verb to negate; «un assistente che Zoho Analytics non **l'**ha mai vista», a
relative with a resumptive clitic; «per la domanda separata **di se**»; «rispondibile», «rimostra»;
«Zoost compresa» on a page that says «Zoost è gratuito» four paragraphs later; and a dozen
inanimate `lei`/`lui`. «file ordinari» for "plain files", where Italian «ordinario» says
*unremarkable* rather than *not a proprietary format* — they are «file di testo»; and «consegnare»
for "hand over", which is what you do with an assignment, where a document you give a colleague is
«condividere». **A mechanical sweep was written for the classes above and then not kept**:
outside the handful of real hits it was almost all noise — every `un elenco`, `un arco`, `un
assistente` flagged as a missing elision — and the rule here is the one already written down, that a
checker with that ratio is one nobody reads. Reading remains the only method for this class.

**The guides' version stamp was the store badge's defect, one page over.** `site.js` fills «Covers
Zoost CRM X · updated <date>» from `/api/versions`, so a browser always sees the truth and the markup
is only a fallback - which nobody had touched since August 3. A reader who does not run scripts met
«Covers Zoost CRM 1.6.1» on a page whose own §4 describes 1.13 as past, and semver says those cannot
both be true. `docs_stamp_is_current()` derives both halves rather than restating them: the version
must equal the app's `manifest.json`, and the date must not be older than the last commit that
touched the page. **Any fact a script fills in has a written fallback, and the fallback is a claim.**

**A disclaimer that is worded differently on each page is doing less than a disclaimer.** The
trademark note in every footer had drifted into four wordings - three English, one of which read «a
family of ... tools. **It is** not affiliated» (plural subject, singular verb), plus a singular
Italian that was correct when there was one product. `trademark_disclaimer_is_one_sentence()` groups
every `<p class="legal">` naming Zoho Corporation by its text and reports more than one per language.

**The nav marks the page you are on, and three pages had stopped.** `aria-current="page"` used to
do one small thing - draw the current entry bold - so nobody noticed it missing. Once the pills
became «outlined unless you are on it», the same attribute became what *fills* them, and a missing
attribute stopped a visible control from working. Reported as «Come si usa non cambia stile» on
`it/how-to`; the sweep then found **`it/crm` and `it/analytics` too**, so on the Italian side the
product pill never filled at all. **I had verified the fill on the English pages only** - the
one-of-a-set miss this file keeps recording, made while fixing something else.
`nav_marks_the_page_you_are_on()` derives the criterion instead of listing it: take the URL the
platform serves for the file, and if the nav links to exactly that URL, that link carries the
attribute and no other does. A page with no self link - the home, `404` - is silent by construction
rather than by exemption. Proven against all four shapes: attribute removed from a product page, a
plain link and a translated hub, and two links marked at once.

**A contextual target is fine; the two languages disagreeing about it is not.** In English the
product pages' «How to» went straight to that product's guide, in Italian it went to the hub. Neither
is wrong and they cannot both be deliberate on the same pages.
`nav_targets_match_across_languages()` pairs the navs positionally and skips anything carrying
`hreflang`, which is the one link whose target must *not* match - the language switch.

**A canonical must be the page's own URL, and a translated pair must point both ways.** Neither was
checked, and both were wrong: `analytics.html` and `index.html` carried `crm.html`'s canonical,
copied along with the head block — which tells a search engine those pages *are* `crm.html`, so the
product page and the suite home were each asking to be dropped. The Italian pages declared their
English original from the day they were written and the English ones said nothing back, which leaves
the engine to pick the language a reader lands on. `canonical_and_alternates()` derives both
criteria from the file's own path, so a page added tomorrow is checked without being listed. Every
check here read the body; nothing read the head.

What is **not** translated, on purpose: `llms.txt` alone, whose reader is a machine and which is the
map of the evidence, so there is one version of it and only one. `privacy.html` *is* translated, and
the English one governs - said on the page itself, because a legal document that exists twice needs
one of the two to win before a difference becomes an argument.

**A page that does not scroll sideways can still contain a block that does — and the sweep only ever
measured the page.** Two overflows reached the user that way: the footer badge's
«Ultima release … in attesa di revisione», 457px of `nowrap` in a 331px column, and the home's status
pill in a `display:flex` header. Both were *inside* an element, so `documentElement.scrollWidth`
equalled the viewport and reported nothing. The sweep now asks every `header, footer, main, section,
.hero, .card, table, pre` whether its own `scrollWidth` exceeds its `clientWidth`, skipping the ones
that scroll on purpose. **And the badge only exists when `/api/versions` answers**, so a sweep run
against a bare local server has `#vers` at `display:none` and can never see it — measure against the
live site, or stub the endpoint.

**`main` was a proxy too, and it broke the moment the landing pages needed one.** 28 rules were
scoped to `main` on the reasoning that the landing pages had none - so `main` was standing in for
«this is a document page», an editorial fact wearing a structural selector. Giving `index`, `crm` and
`analytics` a `<main>` for the skip link would have dropped `h1{font-size:30px}` on a 42px hero and
25 other rules with it, all at once. They are scoped to **`.doc`** now, which the content pages
declare, and the name says what the set actually is.

**Anchors land under a sticky header unless something says otherwise, and the number has to move with
the header.** `.doc h2` carried `scroll-margin-top:70px`, chosen against a 54px desktop header, and
the landing pages' `<section id>` carried nothing. Measured on the live site at 375px, where the
header is **158px**: both of the home's hero links put their heading **106px underneath it**. One
`--anchor-top`, moved by the same conditions that move the header, feeds both architectures.

**Every page carries `<main id="content">` and a skip link**, and the site declares
`color-scheme:dark` so the browser's own scrollbars and form controls stop rendering light over a
`#0d121c` background. `site/404.html` is served by `assets.not_found_handling: "404-page"` - which
has one consequence that would have broken a published extension: **navigation requests then stop
invoking the Worker**, and the Worker is what 301s `/docs.html`, the URL compiled into Zoost for Zoho
CRM 1.9.0. `/docs` and `/docs.html` are in `run_worker_first` for exactly that reason.

**And it took `/api/versions` off the air, which is the part worth remembering.** With a 404 page
configured, a request matching no asset never reaches the Worker - and `/api/versions` matches no
asset. It answered the 404 page to a `fetch` as well as to a navigation, so the footer badge and the
guides' version stamp were dead on every page while the deploy reported success and every page
rendered. **The thing that broke is the one designed to fail quietly.** I had verified the preview
against `/docs` and `/llms.txt` - the routes I happened to think of - which is a checklist, and the
list has to be derived from the script: `tests/tools_test.py` now reads every `url.pathname ===` and
every `MOVED` key out of `_worker.js` and asserts each is covered by `run_worker_first`. Proven by
removing each entry and getting a finding.
`auditcheck` gained `worker_routes_answer()` for it, and note *why* it had to be a new check rather
than a wider `live_matches_repo`: that one compares **files**, and what broke was not a file. It reads
the routes out of `_worker.js` and `wrangler.jsonc` - never a list here - and asks each for the shape
it owes: the endpoint must return JSON carrying the fields `site.js` reads, a `MOVED` source must
redirect *and its target must answer 200*, a `.txt` must carry its charset. Proven by pointing the
route at a path that does not exist and by renaming a redirect source: one finding each.
Its first version reported the charset defect on a header that was correct, because
`%{http_code} %{content_type} %{redirect_url}` splits on a space and `text/plain; charset=utf-8`
contains one - the same lesson as the `\x1e` separator in `whatsnew.py`: **a separator has to be
something the values cannot contain.**

It also poisoned the Worker's own cache: a 404 body was stored under `?v=16` and served with a JSON
content-type afterwards, so **the fix looked like it had not worked**. `CACHE_KEY` is the lever for
exactly that, and this is the second reason to bump it besides a change of payload shape.

**A head block is copied from a neighbour, which is how `og:url` came to disagree with the canonical
on five pages** - so the fixes are held by tests rather than by having been made: every page declares
one canonical with `og:url` equal to it, carries `<main>` and a skip link whose target exists on the
page, and has a description, an `og:image` and a `twitter:card`. Derived from the directory, so a page
added tomorrow is covered without anyone remembering, and proven by breaking each one.

**Open Graph existed on 6 pages of 18**, which are not the pages people paste into a chat: `/try` sent
to someone who has to approve the install rendered as a bare URL. Every page has the block now, and
`og:url` is the canonical - they disagreed on five pages because the rewrite that moved every URL to
its served form matched `href=` and `<loc>` and never `content=`. **Grep the value, not the tag.**

**A width is a proxy for the question; `pointer:coarse` is the question.** The navigation was sized
for touch below 760px, so an iPad upright and a phone held sideways got the mouse sizing back - eight
targets under 44px, measured. Asking the browser whether the thing is being touched or pointed at
covers every device without anyone enumerating them. Two thresholds, and they are different claims:
**24x24 CSS px is WCAG 2.5.8 at level AA and applies whatever is pointing** - the footer's nine links
were **15px tall on a desktop too** - while 44px is Apple's guideline and WCAG's AAA, and is what the
coarse-pointer rule raises them to. **Links inside a sentence are exempt from both and must be left
alone**, or the padding wrecks the line spacing of the prose; the check that matters is therefore not
"how many targets are small" but "how many *standalone* ones are", and the first version of that
measurement counted fifteen inline links on the home and would have sent me editing paragraphs.

**Where the navigation breaks is a decision, and it belongs in the markup.** Seven touch-sized
targets do not fit 375px, so it wrapped wherever the arithmetic ran out - orphaning the language
switch on a line of its own, which reads as an accident because it is one. `<span class="nbrk">` is a
zero-height, full-width flex item after the second product: everything below 760px or on a coarse
pointer starts a new line there, always. Two consequences worth keeping. The products then have a row
to themselves, **so the icon-only tier could go** - «Zoost CRM» fits at every width this site is read
at and never has to shrink to a bare mark, which is one fewer place the name can be lost. And the
break is declared per page rather than achieved with a margin trick, so `sitecheck`'s nav-shape
comparison sees it and a page missing it is reported.

**The nav carries the short product names at every width, and the full ones were costing an
overflow nobody had measured.** `.wrap` is 900px; with `Zoost - workbench for Zoho CRM` and its
sibling the bar came to **874px**, so the header ran **87px outside** the column every other element
respects, and **300px past where the prose ends** - reported by the author as «le voci di menu vanno
molto a destra, fuori dall'ingombro del testo». It predates the AI pill, which added ~46px and made
it visible. Two fixes were tried and measured before the third: letting `.wrap` wrap gives a **100px**
sticky header, and letting the *nav itself* wrap gives **140px** once the Italian labels need a second
line. The short form brings the bar to **584px** (620 in Italian) - one line, 61px, at every width in
both languages, with room for a third product. `Zoost CRM` is the manifest's own `short_name`, not a
fourth form invented to fit, and the full name stays in `aria-label`, in every `<title>`, in the
footer and as each product page's `h1`. `header .wrap` keeps `flex-wrap:wrap` at all widths anyway:
it costs nothing now and makes the overflow structurally impossible if a label ever grows. The auto
margin moved from the nav to the brand, so a wrapped bar starts at the column's left edge instead of
being shoved right.

**And the stylesheet was cached while I measured it, again.** Three iframe sweeps reported a wrap
that was not applying, because `?cb=` busts the *page* and the stylesheet is a separate request. The
computed `flex-wrap` said `nowrap` while the file said `wrap`. Force the linked sheet to reload
inside the frame before believing any measurement of a CSS change - this is the third time it has
cost a wrong reading in this repository.

**The language switch shortens to `IT` / `EN` below 400px, and a flag was refused.** A flag is a
country, not a language - which one for English? - and on Windows the country-flag emoji is not in
the system font at all, so browsers fall back to printing the two letters, which means the width
saving is not even reliable. The name of the language written *in* that language is the W3C's
recommendation and stays the form at every width the word fits. The **`aria-label` carries the whole
sentence** and had to be added: `title` loses to visible content when a browser computes a link's
accessible name, so with «IT» on screen the name would have become «IT».

**The Italian nav found the layout bug, as usual.** «Come si usa» against «How to» overflowed the
second row by about a dozen pixels at 375 and orphaned the switch again; the English page fitted with
room to spare. Below 430px the horizontal padding gives while the 44px targets do not.

**A table of prose does not shrink, it dies - and the page-level sweep could not see it.** Reported
from the privacy policy on a phone: three columns, the first one `white-space:nowrap` around
`(File System Access)` and `chrome.storage.local`, so it took **186px of 316** and left the two prose
columns 128 and 105 - **fourteen characters a line**. Nothing caught it because nothing overflowed:
the table fit by wrapping its text to death, which is the failure mode `overflow-x:auto` is blind to.
Widening one column only moves which column is unreadable; there is no width at which three columns
of sentences fit on a phone.

So below 760px a table whose cells know their column header stops being a grid and becomes **one
block per row**, each value under its own label. The labels are `data-label`, written onto the cells
from the table's own `<th>` text by a script rather than typed, so a table added tomorrow is covered
and the two languages cannot disagree. Tables with no `<thead>` are left as grids on purpose: they
are key/value pairs whose first cell *is* the label, and stacking those would throw the pairing away.

**The same table was quietly bad on a desktop and the report was only about the phone.** Measured at
1280px: the nowrap pinned the first column at 186px and the third was starved to 169 - **23
characters**. Three-column tables now use a fixed layout with the key column bounded (21% / 48% /
31%), which took the worst column to 36. Two-column tables of *prose* - «your situation» against
«what I would do» - get 46/54, and the distinction is derived rather than listed: `data-prose` is
written onto a table whose first column averages more than forty characters, which is a sentence and
not a key. Everything measures at least 30 characters a line now, against 14 at the start.

Two mistakes on the way, both worth keeping. `<th[^>]*>` **matches `<thead>`**, so every table was
labelled with one column too many and the desktop rule hit the wrong tables. And `max-width` on a
table cell does **nothing** in the automatic layout - a specified `width` is a hint the algorithm can
overrule, so the fixed layout has to come with it.

**`minmax(320px, 1fr)` cannot shrink below 320px**, so on a 320px phone the home's two product cards
were 22px wider than their column and the page scrolled sideways - the one thing the responsive rule
here forbids. `minmax(min(320px,100%), 1fr)` is the fix, and there were **twelve** of them across six
pages: found by grepping for the pattern after fixing the first, which is the «walk the others» rule
doing its job. Verified down to 280px.

**And the number being right does not mean the result is.** At 44px the product pills became big
empty blocks with an 18px icon adrift inside, and «Italiano» was orphaned on a row of its own - both
visible only by looking. The icon grows with the pill (24px), and seven comfortable targets simply do
not fit one row at 375px, so two balanced rows is the answer rather than a failure. The site also had
**no focus style at all**; `:focus-visible` now draws a teal ring, verified by reading the computed
outline rather than by trusting the rule.

**Pages are responsive, and that is checked at a width, not eyeballed.** Wide content — tables, long
code tokens, diagrams — scrolls inside its own box; the page body never scrolls sideways. The guides
overflowed 375px by ~95px from code tokens in table cells, and nobody had looked. The nav carries the
name in three forms rather than truncating it: full, then `Zoost CRM`, then the product's own icon
alone under 520px, with `aria-label` holding the full name throughout so the accessible name does not
shrink with the layout. Measure with the iframe sweep — 7 pages × {375, 768, 1280} must all report
zero overflow.

**Name the platform in full, every time: "Zoho CRM", "Zoho Analytics", never the bare word.** On a
page whose subject is *our* Zoho Analytics workbench, "it never writes to Analytics" does not say
which Analytics — and a reader who guesses will as often guess it means us. It is also the safer
trademark posture: nominative use is strongest when the mark is quoted exactly and sits in a
descriptive position, while an unqualified "Analytics" reads as a word we have adopted. The cost is
repetition, and this project has always priced precision above elegance.

**Never let Zoho's product name stand in for ours.** "Zoho CRM · Web Store 1.0.0" in the footer
badge does not read as "the Zoost you can install is 1.0.0" — it reads as a claim about Zoho's
product, and it is false, because 1.0.0 is ours. The same word was standing in for our extensions in
the navigation, the footer links, the home cards and the guide switcher. Nominative use means naming
*their* product when we mean theirs; it does not license borrowing their name for ours. Wherever a
label stands for one of our extensions it reads **"Zoost for Zoho CRM"** / **"Zoost for Zoho
Analytics"** — `sitecheck.py` reports any link, heading or bold run whose entire text is a bare
platform name.

**The name "Zoost" itself was never cleared, and after checking, it is kept.** Three unrelated parties
use it: `zoost.ai` (an AI shopping assistant — the only one in software), `zoostdigital.com` (a
marketing agency) and `zoostwellness.com` (pet supplements). None of them claims a mark: no ® or ™ on
any of the three sites. No "Zoost" registration surfaced in the software classes, and the one filing
found — Australian, 2009 — is dead for non-use. **That is a web search, not a clearance search**: the
official registers (EUIPO, UIBM, USPTO, WIPO) are JavaScript-gated and every consultable mirror
returns 403, so this was not established authoritatively and should not be described as if it were.

The decision is to keep the name and react if something happens, because the legal risk looks low and
the cost is not what it appears. **Renaming is not a find-and-replace.** The verification chain is
identity-bound: an attestation records `https://github.com/ivannot/zoost` in its certificate, and
`gh attestation verify --repo` is validated against the certificate's `SourceRepository`,
`SourceRepositoryOwner` and SAN fields. Artefacts already signed would stay verifiable **only under
the old name**, so the chain would run in two pieces and `RELEASES.md` would have to say which row
belongs to which. On top of that, `zoost.it` could never be retired — published extensions carry
`zoost.it/docs.html` compiled in — so a rename means two domains for good, plus both Store listings,
Cloudflare, the Sponsors page, the contact email, and Search Console starting its clock again.

**What would reopen it:** a live registration found in class 9 or 42 in the EU, Italy or the US; a
complaint from any of the three; or a takedown against a Store listing. The cost of moving grows
monotonically — every release adds an attestation bound to the current identity — so this is a
decision to revisit deliberately, not to drift past.

### The names, settled

**This is fixed. Outward it never bends; between us it can.** Everything a user or a reviewer can
read — the site, the Chrome Web Store copy, `README.md`, every string an extension ships, the release
titles — uses exactly the forms below, always. In conversation, shorthand is fine and nothing needs
correcting; the rule is about what leaves the building, not about how we talk while working.

**The name uses an ordinary hyphen, and that was a deliberate change.** It carried a long dash
until the rule above reached it, and the name is where the rule bites hardest: it is the string that
gets pasted into the Store dashboard, into a release title, into a chat window. «Renaming is not a
find-and-replace» further down still holds — that is about *Zoost*, the word. The punctuation inside
the name is typography, and changing it costs one edit to each `manifest.json` plus the item name in
both Store listings at the next submission.

**The site speaks the short form; the full name introduces the product once, at the top of its own
page.** Both forms stayed legitimate, but using them side by side as *labels* made them read as two
products - reported from the footer, where the version badge says `Zoost CRM` and the link row three
lines below said `Zoost - workbench for Zoho CRM`, four labels for two products with nothing saying
they were the same. And the convention itself appeared **nowhere on the site**: we had a naming rule
and never told the reader.

So wherever the name is an *label* - nav, footer links, badge, home cards, prose - the site says
`Zoost CRM` / `Zoost Analytics`, one form, repeated. Wherever it is an *introduction* - the top of
`/crm` and `/analytics` - the two forms sit adjacent, `Zoost CRM · Zoost - workbench for Zoho CRM`,
above the headline. That states the convention without a note about naming, and it moves the full
name **up**: before this it was visible on a product page only in the footer, because the product
pages' `h1` is a headline about the reader's org and their `<title>` already used the short form.
The footer links keep the full name in `title`.

Measured before deciding, because "the full name will never be seen again" was the objection and it
needed a number: the full form is visible 2 to 6 times per page, and on `/crm` and `/analytics` it
was **2 - both in the footer**. That, not the nav, was the hole.

**Three legitimate forms, and nothing else.** `Zoho CRM` / `Zoho Analytics` name **Zoho's** products
and are used only when we mean theirs. **`Zoost - workbench for Zoho CRM`** is ours in full, and it is
the `name` in `manifest.json` — the authority, never a copy. `Zoost CRM` / `Zoost Analytics` name ours
in short — always carrying *Zoost*, which is why they
are safe. **A bare `CRM` or `Analytics` is never used**, in any position: it is the one form that
cannot say whose product it means. "Zoost" on its own is fine and needs no qualifier — it is already
the family's full name — but "the CRM extension" or "the Analytics one" is not a name, and it made
our own products sound like they were called after Zoho's.

**"workbench" is part of the full name and was nearly lost by accident.** Shortening the nav to fit
produced `Zoost for Zoho CRM` — a fourth form nobody had declared — and it then spread across the
site and displaced the real name, taking with it the word that was chosen deliberately over "IDE".
Nobody shortens the name to make it fit: the nav carries three tiers instead, and the last one is the
icon. `sitecheck.py` now reads the manifest and reports any Zoost+product form that is neither its
`name` nor its `short_name`, so the fourth form cannot come back.

`sitecheck.py` enforces all of it: it strips the three legitimate forms and reports whatever bare
occurrence is left, and separately reports any link, heading or bold run whose *entire* text is a
platform name.

`tools/sitecheck.py` reports a bare platform name in prose; code, paths and markup are exempt,
because `analytics/` is a folder and not a sentence.

**The same rule binds the extensions, and for a long time only the site was checked for it.** The
apps had drifted **27 times** — "No answer from the Analytics page", "Your Analytics role does not
grant access", a `+ Workspace` tooltip, a system-table chip, the CRM's own system prompt — and none
of it was found by a check. Two of them were spotted **by eye, in one file, while doing something
else**, which is the definition of a check that does not exist. `namecheck.py` now runs the same
strip-the-legitimate-forms technique over what an app ships: **JS string literals outside comments**,
and in HTML **the text between tags plus `title` / `placeholder` / `aria-label` / `alt`**. Comments
stay exempt — outward it never bends, between us it can — and anything under 12 characters is skipped,
because a chip reading `Analytics tab` has nowhere to put the platform and demanding prose of a badge
is how a checker starts being ignored. Proven by reintroducing three of the defects, one per surface
type, and getting three findings.

The name comes from `chrome.runtime.getManifest().name` everywhere. Renaming means editing one
field in `manifest.json`.

**Two extensions means every identity surface has to say *which one*.** `name` is not enough on its
own: Chrome shows `short_name` where space is tight (the extensions menu) and
`action.default_title` as the toolbar tooltip, and a bare "Zoost" on both is how you end up unable
to tell them apart. Each app therefore carries a **qualified `short_name`** (`Zoost CRM`,
`Zoost Analytics`), a `default_title` **identical to its `name`**, and its own `<title>` on every
page it ships. The icons share one mark and differ by **hue**, because at 16px in the toolbar the hue
is the only thing left that carries. Adding a third product means doing all four again.

**The Z is one stroked path, and that is the fix for a defect that shipped for months.** It was three
shapes butted together - two rects with their own corner radius, and a polygon whose thickness was
defined by *horizontal* offsets, so the diagonal rendered at three quarters of the bars' weight and
the corners had notches. At favicon size nobody saw it; the first time it was looked at large, it was
obviously three pieces meeting by accident. A stroked centreline gives one weight everywhere and real
joins **by construction**, so it cannot come back through careless drawing.

```
box 24,27 to 104,101 (80x74 in a 128 tile) · stroke-width 18 · square caps · round joins
path = the centreline, inset by half the stroke: M 33 36 L 95 36 L 33 92 L 95 92
```

Round joins, not miter: a Z's corners are acute and miter spikes them past the tile edge - which was
checked by drawing it, not assumed.

**The box is square, and it was not.** It was 80 x 74 - 7.9% wider than tall - which he saw the
second time he looked at it large, and which no test measured because every test read the file
instead of the render. The bars moved to y=33 and y=95, the same two numbers as x, so the box is
80 x 80 centred on 64,64 and the diagonal comes out at exactly 45 degrees. The check is derived from
the path rather than restating it in a comment: the extent on each axis is the centreline span plus
one whole stroke, because a square cap and a round join both extend by half of one - which is why
that test only makes sense sitting next to the cap rule below.

**Square caps, not butt, and this one shipped for an hour before he caught it.** A butt cap ends
exactly on the path's endpoint; a round join bulges half a stroke *past* the vertex. So the top bar
reached x=33 on its capped side and x=104 on its joined side, and the bottom bar the mirror of that:
the two horizontals were **9px out of register with each other**, which reads as a corner not lining
up with the bar opposite it. Measured, not argued - `butt` gives `[33, 103.8]` and `[24, 94.8]`,
`square` gives `[24, 103.8]` for both. A square cap extends by the same half stroke a join does,
which is the whole reason it fixes it. Four tests hold the geometry, the weight, the caps and the
one-hue-each rule, each proven by breaking it.

**The SVG sources are the source of truth, and until now two of the three did not exist.** `apps/crm`
had no `icon.svg` at all - its PNGs came from something nobody kept - and `apps/analytics/icons/icon.svg`
drew a Z *plus three columns* that appear in no shipped PNG, so the one file that looked like a source
was not one. All three now exist and every raster comes from them. There is no rasteriser in this
repository and there will not be one: the PNGs are rendered through a browser canvas
(`tools/icons.html`) and the multi-size `favicon.ico` is assembled from those PNGs by hand, because a
build step for six icons a year is not worth the first dependency.

**Each extension ships a 24 as well, and it is the toolbar's own size.** Chrome's `icons` key uses
16/32/48/128 - page contexts, Windows, the extensions page, install and the Store - and none of them
is redundant. `action.default_icon` is a different question with a different answer: Chrome asks for
16, 24 and 32 there, and with the 24 absent it was scaling a 32 down at some display densities, which
is the one place a mark is read at a glance all day. So the 24 is declared on the action only, and
`test_no_raster_ships_that_nothing_declares` holds the line - a size added to the folder and not to a
manifest is dead weight in a package whose contents are printed into a public log.

Four cases now check the manifests against the files in both directions: every declared icon exists,
is a PNG, and is the size its key claims (read out of the IHDR - a 32 copied over a 24 is invisible
in a listing and wrong in the toolbar); every PNG in the folder is declared by something; and
`tools/icons.html` has a job for each, so a size can never exist once and go stale at the next
regeneration - which is precisely how `apps/crm` ended up with rasters whose source nobody had kept.
The app list is globbed, so a third product is covered without anyone remembering.

**`tools/icons.html` takes `?only=<substring>` and `?auto`**, which is what made adding one size a
one-file change. A full run rewrites every PNG here and the bytes come from whichever Chrome is
installed, so on another machine - or simply after an update - "add a 24" would have arrived as
seventeen changed files with nothing to distinguish the new icon from the re-encoded ones. Driven
headless it is one command:

    python3 tools/icons-receive.py &
    google-chrome --headless --disable-gpu --virtual-time-budget=15000 \
      --dump-dom "http://localhost:<port>/tools/icons.html?auto&only=24.png"
