#!/usr/bin/env python3
"""
sitecheck.py — the site's shared chrome must be the same on every page.

twincheck.py compares the two extension panels. Nothing compared the six pages of zoost.it, and it
showed: the navigation grew a different *shape* on the home and privacy pages — two sub-links where
the other four had one — and was reported by the user, not by a check. A navigation bar that changes
as you move through a site is disorienting in a way that is hard to name and easy to notice.

So: header and footer are compared across all pages, structurally. What may legitimately differ is
declared here with the reason, exactly as in twincheck — and for the same reason, the list is of what
is *allowed* to differ, never of what to look at. Forgetting to declare something makes it reported.

    python3 tools/sitecheck.py
"""
import hashlib
import json
import re
import subprocess
import sys
import pathlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'

# Attributes that carry a page's own identity rather than the chrome's shape.
PER_PAGE_ATTRS = {'aria-current'}

# Links whose *target* is contextual while the item itself is the same on every page. The shape is
# still compared — only the href is exempt.
CONTEXTUAL_HREF = {
    'How to': 'each page points at its own product guide; the home and privacy pages default to the CRM one',
}


def chrome_of(html: str, tag: str) -> str:
    m = re.search(rf'<{tag}>(.*?)</{tag}>', html, re.S)
    return m.group(1) if m else ''


def nav_shape(html: str):
    """The navigation reduced to what a reader perceives: the sequence of items, their kind and label.

    Deliberately ignores href and aria-current — a link that goes somewhere else is invisible; an
    item that is a <span> holding two links where every other page has one <a> is not.
    """
    nav = re.search(r'<nav>(.*?)</nav>', html, re.S)
    if not nav:
        return None
    out = []
    for m in re.finditer(r'<(a|span|button)\b([^>]*)>(.*?)</\1>', nav.group(1), re.S):
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        cls = re.search(r'class="([^"]*)"', attrs)
        label = re.sub(r'<[^>]+>', ' ', inner)
        label = ' '.join(label.split())
        kids = len(re.findall(r'<a\b', inner))
        out.append((tag, (cls.group(1) if cls else ''), label, kids))
    return out


def footer_shape(html: str):
    """The footer's link sequence and its block structure. Copy differs by page; shape must not."""
    foot = chrome_of(html, 'footer')
    if not foot:
        return None
    links = [' '.join(re.sub(r'<[^>]+>', ' ', t).split())
             for t in re.findall(r'<a\b[^>]*>(.*?)</a>', foot, re.S)]
    blocks = re.findall(r'<(div|p)\b[^>]*class="([^"]*)"', foot)
    return (links, blocks)


def bare_platform(html: str):
    """"Analytics" and "CRM" standing alone, meaning Zoho's product.

    On a page whose subject is *our* Zoho Analytics workbench, a sentence like "it never writes to
    Analytics" does not say which Analytics. The reader has to guess, and half the time they will
    guess that the bare word means us. Naming the platform in full every time is also the safer
    trademark posture: nominative use is strongest when the mark is quoted exactly and sits in a
    descriptive position — an unqualified "Analytics" reads as a word we have adopted.

    Code, paths and markup are exempt: `analytics/` is a folder, not a sentence.
    """
    s = re.sub(r'<code>.*?</code>|<pre>.*?</pre>', ' ', html, flags=re.S)
    s = re.sub(r'<[^>]+>', ' ', s)
    # Three legitimate forms, and they are removed before the search so that what remains is only
    # the illegitimate one. "Zoho CRM" is Zoho's product. "Zoost for Zoho CRM" is ours in full.
    # "Zoost CRM" is ours in short — always carrying Zoost, never standing alone. A bare "CRM" or
    # "Analytics" is none of the three and is what this reports.
    # `\s+`, not a literal space: prose wraps, and "Zoho\n    Analytics" is still the legitimate form.
    # A literal space reported it as a bare platform name and would have had prose reflowed to satisfy
    # a checker — the wrong direction, and the sort of thing that teaches people to ignore it.
    s = re.sub(r'Zoost\s+for\s+Zoho\s+(CRM|Analytics)|Zoho\s+(CRM|Analytics)|Zoost\s+(CRM|Analytics)', ' ', s)
    return [' '.join(s[max(0, m.start() - 45):m.end() + 25].split())
            for m in re.finditer(r'\b(Analytics|CRM)\b', s)]


def ours_named_as_theirs(html: str):
    """A label whose whole text is "Zoho CRM" is Zoho's product, not ours.

    The footer badge said "Zoho CRM · Web Store 1.0.0", which does not read as "the Zoost you can
    install is at 1.0.0" — it reads as a statement about Zoho's product, and it is false. The same
    word was standing in for our extension in the nav, the footer links, the cards and the guide
    switcher. Nominative use means naming *their* product when we mean theirs; it does not license
    using their name as shorthand for ours.

    Only checks labels that stand alone — a link, a heading, a bold run whose entire content is the
    platform name. Inside a sentence "Zoho CRM" is almost always the platform and correct.
    """
    return [m.group(2) + f' as a bare <{m.group(1)}>'
            for m in re.finditer(r'<(a|h1|h2|h3|b|strong)\b[^>]*>\s*(Zoho CRM|Zoho Analytics)\s*</\1>', html)]


# The product's full name is the manifest's, read rather than copied — a second copy is a second
# thing to go stale, which is precisely what happened: shortening the nav to fit invented
# "Zoost for Zoho CRM", a fourth form nobody had declared, and it quietly replaced the real name
# across the site. "workbench" went with it, and that word was chosen deliberately over "IDE".
def product_names():
    import json
    root = SITE.parent
    out = {}
    for app in ('crm', 'analytics'):
        m = json.loads((root / f'apps/{app}/manifest.json').read_text(encoding='utf-8'))
        out[app] = (m['name'], m['short_name'])
    return out


def undeclared_form(html: str):
    """Any Zoost+product form that is neither the manifest's full name nor its short_name."""
    names = product_names()
    ok = {n for pair in names.values() for n in pair}
    s = re.sub(r'<code>.*?</code>|<pre>.*?</pre>', ' ', html, flags=re.S)
    # aria-label, title and alt are read aloud or shown on hover — they are text a user receives,
    # so they are collected before the tags are stripped rather than thrown away with them. The
    # first version of this check missed a wrong name planted in an aria-label, which is exactly
    # where a name hides when the visible label has been reduced to an icon.
    attrs = ' '.join(re.findall(r'(?:aria-label|title|alt)="([^"]*)"', s))
    s = re.sub(r'<[^>]+>', ' ', s) + ' ' + attrs
    # Only the words that can genuinely sit inside the name. A looser pattern reported
    # "Zoost reads from the Zoho CRM instance", where "Zoho CRM" is the platform and correct —
    # a checker that cries wolf is a checker nobody reads.
    found = re.findall(r'Zoost(?:\s*[—-]\s*)?\s*(?:workbench\s+)?(?:for\s+)?(?:Zoho\s+)?(?:CRM|Analytics)', s)
    return sorted({f.strip() for f in found if f.strip() not in ok})


# Everything a user can read that is not a page: the repository's front door and the copy pasted
# into the Chrome Web Store. Both are outward-facing, both had drifted, and neither was covered by
# anything — the checks stopped at site/ because that is where the first bug happened to be.
OUTWARD_DOCS = ('README.md', 'store')


def outward_prose():
    root = SITE.parent
    # The map an assistant reads instead of the landing page. It makes claims, so it obeys the same
    # naming rules as everything else a reader receives.
    if (SITE / 'llms.txt').is_file():
        yield SITE / 'llms.txt'
    for name in OUTWARD_DOCS:
        p = root / name
        if p.is_file():
            yield p
        elif p.is_dir():
            yield from sorted(p.rglob('*.md'))


def check_prose(path, findings):
    """Markdown, with inline code removed — a path is not a sentence.

    Fenced blocks are stripped in README.md, where they are shell commands, and **kept** in the
    store listings, where the fence *is* the copy that gets pasted into the dashboard. Stripping
    them there hid the only text on those pages that a user will ever read — which is what happened
    on the first run of this check, and is why the distinction is here rather than one rule for both.
    """
    raw = path.read_text(encoding='utf-8')
    if path.name == 'README.md':
        s = re.sub(r'```.*?```', ' ', raw, flags=re.S)
    else:
        # Drop the fence *markers*, keep what is inside them. Removing the content would hide the
        # only text on these pages anyone reads; leaving the backticks in place is worse still,
        # because the inline-code pattern below then pairs one fence's closing ticks with the next
        # one's opening ticks and deletes everything between two unrelated sections. That silently
        # emptied the file and the check passed on prose it had never seen.
        s = re.sub(r'^\s*```.*$', ' ', raw, flags=re.M)
    s = re.sub(r'`[^`\n]*`', ' ', s)
    rel = path.name if path.parent.name in ('', 'zoost') else f'{path.parent.name}/{path.name}'
    for form in undeclared_form(s):
        findings.append(f'{rel}: {form!r} is neither the manifest name nor its short_name')
    for ctx in bare_platform(s):
        findings.append(f'{rel}: bare platform name — …{ctx}…')


def store_field_limits(findings: list) -> None:
    """A store field that does not fit is a submission that stops at the form.

    Each section in `store/<app>/store-listing.md` names its own ceiling in its heading, so the
    criterion is derived rather than listed — a section added tomorrow is measured without anyone
    remembering, and changing a limit means editing the heading and nothing else. The CRM's storage
    justification had been over 1000 characters for some time and nothing was counting; it was found
    by counting while editing it, which is luck rather than process.
    """
    for md in sorted(ROOT.glob('store/*/store-listing.md')):
        text = md.read_text(encoding='utf-8')
        for m in re.finditer(r'## (\d+)\. ([^\n]*?)\(max (\d+)\)\n+```\n(.*?)\n```', text, re.S):
            n, cap = len(m.group(4)), int(m.group(3))
            if n > cap:
                findings.append(f'{md.relative_to(ROOT)}: §{m.group(1)} {m.group(2).strip()} is '
                                f'{n} characters, {n - cap} over the {cap} the dashboard accepts')


def txt_served_by_worker(findings: list) -> None:
    """Every `.txt` the site ships must be routed through the Worker.

    A `.txt` has no way to declare its own encoding, so the header is the only place it can be said —
    and the Worker is the only thing that can set it. Static assets are served *first*, so a file that
    is not in `run_worker_first` never reaches the code that adds the charset, and the browser falls
    back to guessing: every em-dash in llms.txt arrived as `â€”`. That defect was reported, "fixed",
    and stayed live, because the fix was verified by reading the bytes — which had never been wrong.

    The list in the config is therefore derived from the directory rather than trusted: add a `.txt`
    and forget the route, and this says so.
    """
    cfg = ROOT / 'site' / 'wrangler.jsonc'
    if not cfg.exists():
        findings.append('site/wrangler.jsonc: missing — nothing declares how assets are served')
        return
    text = cfg.read_text(encoding='utf-8')
    routed = set(re.findall(r'"(/[^"]*\.txt)"', text))
    for f in sorted(SITE.glob('*.txt')):
        want = '/' + f.name
        if want not in routed:
            findings.append(f'site/{f.name}: not in run_worker_first, so it is served straight from '
                            f'assets and goes out with no charset')


def hosts_declared(findings: list) -> None:
    """Every host an extension may reach must be named in the privacy policy.

    `one.zoho.*` sat in the Zoho CRM manifest and not in §5's opening paragraph, which said the CRM
    workbench reaches "the Zoho CRM and sandbox data centres" — six hosts short. A bullet further down
    did list it, which is how it survived three readings: the page contained the fact and the sentence
    a reader starts from did not.

    Derived from the manifests, so a host added tomorrow is checked without anyone remembering, and a
    host removed stops being required. The unit is the family (`crm.zoho`, `one.zoho`) rather than each
    data centre, because the page names them that way and listing twenty domains would be worse prose.
    """
    policy = (SITE / 'privacy.html')
    if not policy.exists():
        findings.append('site/privacy.html: missing — nothing declares where the extensions may reach')
        return
    text = policy.read_text(encoding='utf-8')
    for mf in sorted(ROOT.glob('apps/*/manifest.json')):
        app = mf.parent.name
        data = json.loads(mf.read_text(encoding='utf-8'))
        families = set()
        for h in data.get('host_permissions', []):
            host = re.sub(r'^https?://', '', h).split('/')[0]
            parts = host.split('.')
            families.add('.'.join(parts[:2]) if len(parts) > 2 else host)
        for fam in sorted(families):
            if fam not in text:
                findings.append(f'apps/{app}/manifest.json: host_permissions reach {fam}.* and '
                                f'site/privacy.html never names it')


WORDS = {6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve'}
IT_WORDS = {6: 'sei', 7: 'sette', 8: 'otto', 9: 'nove', 10: 'dieci', 11: 'undici', 12: 'dodici'}


NUM = {8: ('eight', 'otto'), 9: ('nine', 'nove'), 10: ('ten', 'dieci'), 11: ('eleven', 'undici'),
       12: ('twelve', 'dodici'), 13: ('thirteen', 'tredici'), 14: ('fourteen', 'quattordici'),
       15: ('fifteen', 'quindici'), 16: ('sixteen', 'sedici'), 17: ('seventeen', 'diciassette'),
       18: ('eighteen', 'diciotto'), 19: ('nineteen', 'diciannove'), 20: ('twenty', 'venti')}


def translations_have_the_same_shape(findings: list) -> None:
    """The two languages carry the same blocks, once the declared Italian-only ones are removed.

    `translations_current()` catches one direction: the English page moves and the Italian does not.
    It cannot catch the other, and the other is the one this project actually produces - the author
    reads the site in Italian, so that is where he finds things, and a sentence fixed only there
    leaves the authoritative language behind while every check stays green.

    Counting blocks is an approximation and is meant to be: it will not see a paragraph rewritten in
    one language only. It will see one *added* or removed, which is what a fix normally looks like.
    A legitimate addition declares itself with `data-it-only`, the same escape hatch the prose check
    uses - forgetting to declare it makes the page reported, never silently exempt.
    """
    for en in sorted(SITE.glob('*.html')):
        it = SITE / 'it' / en.name
        if not it.exists():
            continue
        def blocks(page):
            t = page.read_text(encoding='utf-8')
            t = re.sub(r'<(\w+)[^>]*\bdata-it-only\b[^>]*>.*?</\1>', '', t, flags=re.S)
            body = t[t.index('<main'):t.index('</main>')] if '<main' in t else t
            return len(re.findall(r'<(p|li|h2|h3|tr)[ >]', body))
        a, b = blocks(en), blocks(it)
        if a != b:
            findings.append(f'site/it/{en.name} carries {b} content blocks against {a} in English - '
                            f'one language has gained or lost something the other has not. If the '
                            f'Italian is right, the English is the version that governs: fix it there '
                            f'first. If the addition is deliberate, mark it data-it-only.')


def file_count_is_derived(findings: list) -> None:
    """«Twelve files of plain JavaScript for Zoho CRM and ten for Zoho Analytics» - counted, not guessed.

    It read «about twenty» in five places, which was true enough and is the shape of claim that ages in
    silence: nobody re-counts a number that was approximate on purpose. The pages state the real figure
    now, so the real figure has to be checked - it is what «you can read all of it in an afternoon»
    rests on, and it is the sentence an approver is most likely to test.
    """
    counts = {a.name: len(list(a.glob('*.js'))) for a in sorted((ROOT / 'apps').iterdir()) if a.is_dir()}
    for rel in ('index.html', 'nerd.html', 'llms.txt', 'it/index.html', 'it/nerd.html'):
        page = SITE / rel
        if not page.exists():
            continue
        text = page.read_text(encoding='utf-8')
        if 'JavaScript' not in text and 'javascript' not in text:
            continue
        lang = 1 if rel.startswith('it/') else 0
        for app, n in counts.items():
            word = NUM.get(n, (str(n), str(n)))[lang]
            product = 'Zoho CRM' if app == 'crm' else 'Zoho Analytics'
            # The number has to sit next to the product it counts, and the sentence in between is
            # the writer's business: «twelve files of plain JavaScript for Zoho CRM» and «and ten for
            # Zoho Analytics» are both fine. A checker that demands one phrasing is a checker that
            # edits prose.
            near = re.search(rf'\b{word}\b[^.<]{{0,80}}?{re.escape(product)}', text, re.I)
            if not near:
                findings.append(f'site/{rel}: {app} ships {n} .js files, and «{word}» does not appear '
                                f'beside «{product}» - a number in prose is a claim, and it is checkable')


def data_centre_count_is_derived(findings: list) -> None:
    """The privacy policy states how many data centres each extension reaches, and the manifests decide.

    A number written into prose is a claim that has to be maintained, and this one moves whenever Zoho
    opens a data centre - which it does: the six here became nine the day anyone measured. The page may
    keep the figure, it may not keep a wrong one.
    """
    counts = set()
    for app in sorted(p.name for p in (ROOT / 'apps').iterdir() if p.is_dir()):
        data = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
        pre = f'https://{"crm" if app == "crm" else app}.'
        counts.add(len({h[len(pre):].rstrip('/*') for h in data.get('host_permissions', [])
                        if h.startswith(pre)}))
    if len(counts) != 1:
        findings.append(f'the extensions reach a different number of data centres ({sorted(counts)}) - '
                        f'site/privacy.html says «each», which is then wrong for one of them')
        return
    n = counts.pop()
    for rel, words in (('privacy.html', WORDS), ('it/privacy.html', IT_WORDS)):
        page = SITE / rel
        if not page.exists():
            continue
        text = page.read_text(encoding='utf-8')
        said = [w for k, w in words.items() if re.search(rf'<b>{w}</b>', text)]
        if not said:
            findings.append(f'site/{rel}: no data-centre count is stated - it was, and a number that '
                            f'quietly disappears is not a correction')
        elif said != [words[n]]:
            findings.append(f'site/{rel}: says {said} data centres, the manifests reach {n} ({words[n]})')


# ---------------------------------------------------------------------------------------------------
# Translations
# ---------------------------------------------------------------------------------------------------

TRANSLATED_FROM = re.compile(r'<!--\s*translated-from:\s*(\S+)\s*sha256:([0-9a-f]{8,64})\s*-->')


# The cache-busting token on an asset URL, which `tools/siteimg.py` writes from the asset's own
# bytes. It is not prose: re-rendering a screenshot must not report every translation as behind.
STAMPED_URL = re.compile(r'(\.(?:webp|png|css|js))\?v=[0-9a-f]+')


def source_digest(path: pathlib.Path) -> str:
    """A short digest of the English page, with the asset stamps normalised out.

    They were in it, and the first re-render after they arrived reported every translated page as
    stale - a finding with nothing behind it, in the one check whose value is that its findings are
    real. A token changing is a picture changing, which is not a reason to re-read a translation."""
    return hashlib.sha256(STAMPED_URL.sub(r'\1', path.read_text(encoding='utf-8'))
                          .encode('utf-8')).hexdigest()[:16]


def translations_current(findings: list) -> None:
    """A translated page records a digest of the English page it was made from, and this compares it.

    Without it the second language is the thing this repository spends all its effort not having: a
    surface that can quietly stop being true. Nobody has to remember to update the Italian — forgetting
    makes it *reported*, which is the only direction that fails safe.

    The digest is of the **content**, not of the commit that last touched it. The first version used
    the commit and was wrong in a way only using it revealed: editing the English page and its
    translation in one change leaves the marker naming the commit *before* that change, so the check
    fires on a translation that is perfectly current and cannot be satisfied until a second commit
    exists. A content digest is atomic — update both files and the marker in one go and it is right.

    The marker lives in the file rather than a side table, so whoever copies the page carries it.
    """
    if not (SITE / 'it').is_dir():
        return
    for page in sorted((SITE / 'it').glob('*.html')):
        text = page.read_text(encoding='utf-8')
        m = TRANSLATED_FROM.search(text)
        if not m:
            findings.append(f'site/it/{page.name}: no `translated-from` marker, so nothing can tell '
                            f'whether it is still in step with the English page')
            continue
        src, recorded = m.group(1), m.group(2)
        origin = ROOT / src
        if not origin.exists():
            findings.append(f'site/it/{page.name}: says it was translated from {src}, which does not exist')
            continue
        now = source_digest(origin)
        if now != recorded:
            findings.append(f'site/it/{page.name}: {src} has changed since this was translated '
                            f'(page says {recorded}, it is now {now}) — retranslate what moved, then '
                            f'update the marker')


# Classes that are hooks for site.js rather than appearance: the element is empty in the markup and
# its text is written at runtime. Styling them would be the finding, not the absence.
SCRIPT_HOOKS = {'cyear', 'dv', 'dd'}


def carried_by(html: str, cls: str) -> set:
    """Which element tags actually carry this class on this page."""
    return {m.group(1).lower() for m in
            re.finditer(r'<(\w+)\b[^>]*class="[^"]*(?<![\w-])' + re.escape(cls) + r'(?![\w-])', html)}


def defines(css: str, cls: str, tags: set) -> bool:
    """Is `cls` styled for the elements that carry it?

    Two boundaries, and the second was missing for as long as this check existed.

    Trailing: `f'.{c}' in css` was the substring test the original one-liner used, and it counts
    `.cards` as a definition of `.card`.

    Leading: **`main td.k` is not a definition of `.k` on a `<span>`.** The site carried `.k` on
    `<span>` in four product pages, each defining it in its own inline block, and a fifth page then
    used it with no rule at all - the span rendered as ordinary text and this check passed, because
    `td.k` in site.css matched the pattern. A selector qualified by an element name is a narrower
    claim than the class, and it does not answer for the class.

    But "qualified" is not the test, or the check turns on itself: `.nprod.ncrm` is a compound of two
    classes and does style `.ncrm`, and `td.p` is perfectly good for a class that is only ever used on
    a `td`. So the question is not how the selector is written - it is whether it reaches the elements
    that actually carry the class *on this page*, which the markup can be asked.
    """
    for m in re.finditer(r'\.' + re.escape(cls) + r'(?![\w-])', css):
        before = css[:m.start()]
        qual = re.search(r'([\w-]+)$', before)
        if not qual:
            return True                                  # plain `.c`
        start = qual.start(1)
        if start and before[start - 1] in '.#':
            return True                                  # `.other.c` / `#id.c` - still reaches it
        if qual.group(1).lower() in tags or not tags:
            return True                                  # `td.c`, and a `td` carries it
    return False


def classes_defined(findings: list) -> None:
    """Every class a page uses must be styled by CSS *that page loads*.

    The one-liner in CLAUDE.md concatenated site.css with every page's inline <style> and then asked
    each page separately — so a class defined in one page's inline block read as defined on all of
    them, which is precisely the defect it was written to catch. It found nothing for months while
    /how-to.html rendered its two product cards, and both guides their callouts, as unstyled text:
    `.card`, `.cards` and `.note` live in the landing pages' inline styles and in no shared file.

    Per page, therefore: site.css plus that page's own <style>, and nothing else.
    """
    base = (SITE / 'site.css').read_text(encoding='utf-8')
    for p in sorted(SITE.glob('*.html')) + sorted((SITE / 'it').glob('*.html')):
        html = p.read_text(encoding='utf-8')
        css = base + ''.join(re.findall(r'<style>(.*?)</style>', html, re.S))
        used = {c for m in re.findall(r'class="([^"]*)"', html) for c in m.split()}
        missing = sorted(c for c in used - SCRIPT_HOOKS if not defines(css, c, carried_by(html, c)))
        if missing:
            findings.append(f'{p.relative_to(SITE).as_posix()}: uses {", ".join(missing)} — no rule '
                            f'in site.css or in this page, so it renders as nothing')


def headings_by_id(html: str) -> dict:
    """id → the heading text a reader sees when they land on it."""
    out = {}
    for m in re.finditer(r'<section[^>]*\bid="([^"]+)"[^>]*>([\s\S]{0,500}?)</h2>', html):
        t = re.search(r'<h2[^>]*>(.*?)$', m.group(2), re.S)
        if t:
            out[m.group(1)] = ' '.join(re.sub(r'<[^>]+>', ' ', t.group(1)).split())
    for m in re.finditer(r'<(h1|h2|h3)[^>]*\bid="([^"]+)"[^>]*>(.*?)</\1>', html, re.S):
        out[m.group(2)] = ' '.join(re.sub(r'<[^>]+>', ' ', m.group(3)).split())
    return out


def anchors_resolve(findings: list) -> None:
    """An in-page link must exist, and must be called what it lands on.

    The second half is the one that was actually wrong, and it is a contract older than the web we
    build on: a link labelled X takes you to a heading labelled X. The CRM page's hero offered
    «How it works» pointing at `#start`, which is the six-step install list at the very bottom, past
    everything the button was meant to show. «See the two» landed on «The workbenches». Nothing was
    broken; the reader was simply told one name and shown another, and had to translate.

    The **id** is held to the same rule, because it is not invisible — it is in the address bar and
    in a copied link — so `#shared` for a section called «What every Zoost has in common» is the same
    defect one layer down. It is compared loosely (a slug of the heading, or a prefix of it): the
    heading is sometimes a sentence and a URL should not be.

    Numbering is not a name: «section 8, Connections» is fine, and so is a guide's table of contents
    whose entries drop the number the heading carries.
    """
    def slug(t: str) -> str:
        t = re.sub(r'^\d+\.\s*', '', t).lower().replace('\u2019', '').replace("'", '')
        return re.sub(r'[^a-z0-9]+', '-', t).strip('-')

    for p in sorted(SITE.glob('*.html')) + sorted((SITE / 'it').glob('*.html')):
        rel = p.relative_to(SITE).as_posix()
        html = p.read_text(encoding='utf-8')
        ids = set(re.findall(r'\bid="([^"]+)"', html))
        heads = headings_by_id(html)
        for m in re.finditer(r'<a[^>]*href="#([^"]+)"[^>]*>(.*?)</a>', html, re.S):
            frag = m.group(1)
            if frag not in ids:
                findings.append(f'{rel}: href="#{frag}" — no element has that id')
                continue
            head = heads.get(frag)
            if head is None:
                continue                       # an anchor on something that is not a heading
            label = ' '.join(re.sub(r'<[^>]+>', ' ', m.group(2)).split()).strip(' →?')
            hs = slug(head)
            if slug(label) != hs and hs not in slug(label):
                findings.append(f'{rel}: the link «{label}» goes to a section called “{head}” — '
                                f'a link is called what it lands on')
        for frag, head in heads.items():
            if f'href="#{frag}"' not in html:
                continue                       # nothing links it; the id is not a promise to anyone
            if rel.startswith('it/'):
                # The id is the section's structural name and is deliberately the same in both
                # languages, so a fragment keeps working when you switch language. Holding it to the
                # *Italian* heading would force two different anchors for one section and break that.
                # The label rule above still applies here, and it is the one a reader sees.
                continue
            hs = slug(head)
            if frag != hs and not hs.startswith(frag.replace('-', '')) and frag not in hs:
                findings.append(f'{rel}: id="{frag}" sits on “{head}” — the fragment in the address '
                                f'bar should be that heading, not a synonym for it')


def translations_link_to_translations(findings: list) -> None:
    """A link from an Italian page to a page that has an Italian version must use it.

    Reported by the user: the Italian home's two «Come si usa →» links opened the English guides,
    which are the one thing on that page a reader would click expecting Italian. Nothing was looking
    — every check here reads prose or chrome, and a wrong href is neither.

    Two of the others were worse than an oversight: they had been fixed, and then thrown away by a
    `git checkout` used to undo a deliberate mutation while proving a different checker, which
    reverted the real work sitting uncommitted in the same file. Nothing noticed, and the page went
    out linking the English guide *and* claiming the guide was English-only.

    Cross-language links that are deliberate — «la versione inglese di questa pagina», the switch in
    the nav — declare it with `hreflang="en"`, which is what that attribute is for. Everything else
    is a slip.
    """
    for p in sorted((SITE / 'it').glob('*.html')):
        html = p.read_text(encoding='utf-8')
        for m in re.finditer(r'<a\b([^>]*)href="(/[^"]*)"([^>]*)>(.*?)</a>', html, re.S):
            attrs, href = m.group(1) + m.group(3), m.group(2)
            if 'hreflang="en"' in attrs:
                continue
            target = 'index.html' if href in ('/', '/index.html') else href.lstrip('/')
            if not target.startswith('it/') and (SITE / 'it' / target).exists():
                label = ' '.join(re.sub(r'<[^>]+>', ' ', m.group(4)).split())
                findings.append(f'it/{p.name}: «{label[:40]}» links to {href}, but it/{target} exists '
                                f'— an Italian page links Italian, or says why with hreflang="en"')


def shared_prose_stays_shared(findings: list) -> None:
    """Prose identical on two English pages must stay identical on their two translations.

    The twin rule, one layer down and previously unchecked. `crm.html` and `analytics.html` say the
    same twenty things word for word — how a release is built, what an attestation does not prove,
    what happens when an undocumented interface breaks — because they are one product's claims stated
    twice. The Italian pages said eleven of those twenty differently: «leggi ciò che viene spedito»
    against «leggi quello che viene distribuito», «un passo manuale» against «un passaggio manuale».
    Nothing was wrong in either, and that is the point — a reader moving between the two pages meets
    the same sentence twice in two voices, and the twins stop reading as twins.

    It pairs blocks up by **position**, which works because a translation is structurally the page it
    was made from: same sections, same paragraphs, in the same order. Counting instead was the first
    version, and it was demonstrably useless — the Italian pages happened to share one or two blocks
    the English ones do not, and that spare was exactly enough slack to swallow a real drift when one
    was reintroduced on purpose. A checker that goes quiet on the bug it was written for is worse
    than none, so this one names the block.

    Positions must therefore line up, and where a translation legitimately adds something — the note
    saying the control names stay in English — the element carries `data-it-only` and is skipped.
    That direction is the point, as everywhere else here: forgetting to declare an addition makes the
    page *reported*, not silently exempt.
    """
    def blocks(p: Path) -> list:
        s = p.read_text(encoding='utf-8')
        if '</header>' not in s or '<footer>' not in s:
            return []
        starts = [s.index(t) for t in ('<section', '<main') if t in s]
        s = s[min(starts) if starts else s.index('</header>'):s.index('<footer>')]
        return [' '.join(re.sub(r'<[^>]+>', ' ', m.group(3)).split())
                for m in re.finditer(r'<(p|h3|li|td)\b([^>]*)>(.*?)</\1>', s, re.S)
                if 'data-it-only' not in m.group(2)]

    pages = sorted(p.name for p in SITE.glob('*.html'))
    aligned = {}
    for name in pages:
        it = SITE / 'it' / name
        if not it.exists():
            continue
        en_b, it_b = blocks(SITE / name), blocks(it)
        if len(en_b) != len(it_b):
            findings.append(f'it/{name} has {len(it_b)} text blocks where {name} has {len(en_b)} — a '
                            f'translation follows its original\'s structure; mark anything the Italian '
                            f'page adds with data-it-only')
            continue
        aligned[name] = (en_b, it_b)

    for a, b in ((x, y) for i, x in enumerate(sorted(aligned)) for y in sorted(aligned)[i + 1:]):
        (ea, ia), (eb, ib) = aligned[a], aligned[b]
        seen = set()
        for i, text in enumerate(ea):
            if len(text) < 40 or text in seen or text not in eb:
                continue
            seen.add(text)
            j = eb.index(text)
            if ia[i] != ib[j]:
                # Show where they part, not the first 45 characters: the drift is usually a word deep
                # into a long sentence, and two identical-looking prefixes name nothing.
                k = next((n for n, (x, y) in enumerate(zip(ia[i], ib[j])) if x != y),
                         min(len(ia[i]), len(ib[j])))
                findings.append(f'it/{a} and it/{b} word the same claim two ways — {a} and {b} both '
                                f'say "{text[:55]}…"; the Italian differs from …{ia[i][max(0, k - 20):k + 35]}… '
                                f'/ …{ib[j][max(0, k - 20):k + 35]}…')


def canonical_and_alternates(findings: list) -> None:
    """A page's canonical must be its own URL, and a translated pair must point at each other.

    Two English pages carried `crm.html`'s canonical, copied along with the head block. That is not a
    cosmetic slip: a canonical naming another page tells a search engine the two *are* one page, and
    the other one wins — so the Analytics product page and the suite home were both asking to be
    dropped in favour of the CRM page. Nothing reported it because every check here reads the body.

    The reciprocal `hreflang` is the same shape of defect one step further out: the Italian pages
    declared their English original from the day they were written, and the English ones said nothing
    back for as long as they existed. A one-way pair is not a pair — the language a reader lands on is
    then decided by which of the two the engine happened to index.

    Both criteria are derived from the file's own path, so a page added tomorrow is checked without
    anyone remembering to list it.
    """
    def url_of(p: Path) -> str:
        """The URL the platform actually serves — which is not the file's path.

        This derived `https://zoost.it/crm.html` for months while Cloudflare served that file at
        `/crm` and 307'd the `.html` form to it. So every page declared a canonical pointing at a
        URL that redirected, and `/crm` — the one that answers 200 — declared itself an alternative
        of it. Neither could be indexed: Search Console reported "alternative page with proper
        canonical tag" and the product page was invisible. Nothing here caught it because every
        criterion was derived from the repository and none from the platform, and `auditcheck.py`
        had the right rule in `published_path()` the whole time. Two tools, two answers, and nobody
        compared them — so this is deliberately the same rule, kept beside its twin.
        """
        rel = p.relative_to(SITE).as_posix()
        if rel.endswith('index.html'):
            return f'https://zoost.it/{rel[:-len("index.html")]}'
        return f'https://zoost.it/{rel[:-5]}' if rel.endswith('.html') else f'https://zoost.it/{rel}'

    for p in sorted(SITE.glob('*.html')) + sorted((SITE / 'it').glob('*.html')):
        # 404.html is served at every address that has nothing behind it, so it has no URL of its
        # own to be canonical for - and it carries `noindex`, which is the opposite instruction.
        # Declared here rather than skipped silently, like everything else this file exempts.
        if p.name == '404.html':
            continue
        html = p.read_text(encoding='utf-8')
        rel = p.relative_to(SITE).as_posix()
        m = re.search(r'<link rel="canonical" href="([^"]+)"', html)
        if not m:
            findings.append(f'{rel}: no canonical')
        else:
            want = {url_of(p)}
            if m.group(1) not in want:
                findings.append(f'{rel}: canonical points at {m.group(1)}, which is a different page — '
                                f'expected {url_of(p)}')

        # the translated pair, in whichever direction this page sits
        twin = (SITE / 'it' / p.name) if p.parent == SITE else (SITE / p.name)
        if not twin.exists():
            continue
        alts = dict((lang, href) for lang, href in
                    re.findall(r'<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"', html))
        for lang, other in (('en', SITE / p.name), ('it', SITE / 'it' / p.name)):
            if alts.get(lang) != url_of(other):
                findings.append(f'{rel}: hreflang="{lang}" is {alts.get(lang)!r}, but the {lang} page '
                                f'is at {url_of(other)} — a translated pair points both ways or neither')


# ---------------------------------------------------------------------------------------------------
# The trademark disclaimer, and the guides' version stamp
# ---------------------------------------------------------------------------------------------------

def trademark_disclaimer_is_one_sentence(findings: list) -> None:
    """Quasi-legal text repeated in every footer, and it had drifted into four wordings.

    Three in English - "an independent, unofficial developer tool. It is not", "a family of ... tools.
    They are not", and a home page reading "a family of ... tools. **It is** not", which is a plural
    subject with a singular verb - plus a singular Italian, correct when there was one product. A
    disclaimer that is worded differently on each page is doing less than a disclaimer.
    """
    for lang, pages in (('en', sorted(SITE.glob('*.html'))), ('it', sorted((SITE / 'it').glob('*.html')))):
        seen = {}
        for f in pages:
            for m in re.finditer(r'<p class="legal">([\s\S]*?)</p>', f.read_text(encoding='utf-8')):
                txt = ' '.join(re.sub(r'<[^>]+>', '', m.group(1)).split())
                if 'Zoho Corporation' not in txt:
                    continue
                seen.setdefault(txt, []).append(f.name)
        if len(seen) > 1:
            findings.append(f'The trademark disclaimer has {len(seen)} wordings in {lang}:')
            for txt, files in sorted(seen.items(), key=lambda kv: -len(kv[1])):
                findings.append(f'    {", ".join(files)}')
                findings.append(f'      {txt[:120]}')


MONTHS = {'en': ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
                 'October', 'November', 'December'],
          'it': ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto',
                 'settembre', 'ottobre', 'novembre', 'dicembre']}


DATE = re.compile(
    r'\b\d{4}-\d{2}-\d{2}\b'
    r'|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November'
    r'|December|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre'
    r'|dicembre)\s+\d{4}\b')


def no_date_is_typed(findings: list) -> None:
    """A date a reader can see must come from the system that holds it, never from a keystroke.

    The author's argument, and it is the stronger form of everything else in this file: a date typed
    into a file is unverifiable by construction, and free to disagree with the record it claims to
    describe - «potrei per assurdo inserire una data diversa da quella registrata». GitHub timestamps
    every commit and tag, Google reports the state of a submission, Cloudflare reports when the site
    went live. Anything else is someone's memory of an event, written down.

    So: no date in outward prose, unless it is inside a `data-stamp` element - which `tools/stamp.py`
    rewrites from the manifest and from git, and which therefore cannot drift without being reported.
    The criterion is structural rather than a list of permitted values: a new stamp is declared where
    it lives, and forgetting to declare one is what gets reported.

    Exempt, and each for a reason rather than by being listed: code and `<pre>`, where a date is a
    value (`anthropic-version: 2023-06-01`) rather than a claim; `sitemap.xml`, whose every `lastmod`
    is derived by `tools/sitemap.py`; and comments, which no reader sees - outward it never bends,
    between us it can.
    """
    scan = [(f'site/{p.relative_to(SITE)}', p) for p in sorted(SITE.rglob('*.html'))]
    scan += [(str(p.relative_to(ROOT)), p) for p in
             sorted((ROOT / 'store').rglob('*.md')) + [ROOT / 'RELEASES.md', ROOT / 'README.md']]
    for rel, f in scan:
        t = f.read_text(encoding='utf-8')
        t = re.sub(r'<!--.*?-->|<script\b.*?</script>|<code>.*?</code>|<pre>.*?</pre>', ' ', t, flags=re.S)
        if f.suffix == '.md':
            # Markdown code: inline, and indented by four. Applied to HTML this blanked most of every
            # page - markup is indented - so the check went silent on the whole site while reporting
            # zero, which is the failure mode this project treats as worse than having no check. It
            # was found by mutating a page and getting nothing back.
            t = re.sub(r'`[^`]*`|^\s{4}.*$', ' ', t, flags=re.M)
        t = re.sub(r'<(\w+)[^>]*\bdata-stamp="[^"]*"[^>]*>.*?</\1>', ' ', t, flags=re.S)
        for m in DATE.finditer(t):
            findings.append(f'{rel}: the date "{m.group(0)}" is typed, not derived - it must come '
                            f'from git, from the Store API or from the deployment, inside a '
                            f'data-stamp element that tools/stamp.py writes')


def stamps_are_derived(findings: list) -> None:
    """The version and date printed on a page, checked by re-deriving them.

    This used to be a reader here: it parsed the guides' "Covers Zoost X · updated <date>" line and
    compared the two halves against the manifest and against git. It is now `tools/stamp.py` that
    *writes* them, so checking them anywhere else would be a second opinion free to disagree with the
    generator - the duplication this project spends its length removing. One call, one criterion, and
    it covers the privacy policy's date too, which nothing here ever looked at.
    """
    out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'stamp.py'), '--check'],
                         cwd=ROOT, capture_output=True, text=True)
    if out.returncode:
        findings.extend(line.strip() for line in out.stdout.splitlines()[1:] if line.strip())


def nav_targets_match_across_languages(findings: list) -> None:
    """A contextual *target* is fine; the two languages disagreeing about it is not.

    In English the product pages' "How to" went straight to that product's guide, in Italian it went
    to the hub. Neither is wrong, and they cannot both be deliberate on the same pages.
    """
    for it in sorted((SITE / 'it').glob('*.html')):
        en = SITE / it.name
        if not en.exists():
            continue
        # The language switch is skipped: it points at the other language by design, which is the
        # one link whose target must *not* match. It declares itself with hreflang, which is what
        # that attribute is for and what translations_link_to_translations already relies on.
        pair = []
        for p in (en, it):
            nav = re.search(r'<nav[\s\S]*?</nav>', p.read_text(encoding='utf-8'))
            links = re.findall(r'<a\b([^>]*)>', nav.group(0)) if nav else []
            pair.append([re.search(r'href="([^"]+)"', a).group(1) for a in links
                         if 'hreflang' not in a and re.search(r'href="([^"]+)"', a)])
        want = [h if h.startswith(('http', 'mailto', '/llms')) else
                ('/it' + h if not h.startswith('/it/') else h) for h in pair[0]]
        norm = pair[1]
        if len(want) == len(norm):
            for a, b in zip(want, norm):
                if a != b and not (a.endswith('index.html') or b.endswith('index.html')):
                    findings.append(f'site/it/{it.name}: nav points at {b}, the English page points at '
                                    f'{a.replace("/it/", "/", 1)} — same label, different destination')


def nav_marks_the_page_you_are_on(findings: list) -> None:
    """A page whose nav links to itself has to say so, and three did not.

    `aria-current="page"` is what draws the current entry bold, and once the pills became "outlined
    unless you are on it", it is also what fills them. Missing, the control silently stops working -
    which is how it was found: reported as «Come si usa non cambia stile», on `it/how-to`. The sweep
    then showed **`it/crm` and `it/analytics` too**, so on the Italian side the product pill never
    filled at all - and I had verified the fill on the English pages only, which is the one-of-a-set
    miss this repository keeps recording.

    The criterion is derived, never listed: take the URL the platform serves for this file, and if
    the nav contains a link to exactly that URL, that link must carry the attribute and no other may.
    A page with no self link - the home, 404 - is silent by construction rather than by exemption.
    """
    def served(rel: str) -> str:
        rel = rel.removesuffix('.html')
        return '/' + rel.removesuffix('index').rstrip('/') if not rel.endswith('index') else '/' + rel[:-5]

    for p in sorted(SITE.glob('*.html')) + sorted((SITE / 'it').glob('*.html')):
        rel = str(p.relative_to(SITE))
        me = served(rel)
        html = p.read_text(encoding='utf-8')
        nav = re.search(r'<nav[\s\S]*?</nav>', html)
        if not nav:
            continue
        links = re.findall(r'<a\b([^>]*)>', nav.group(0))
        mine = [a for a in links if re.search(r'href="([^"]+)"', a)
                and re.search(r'href="([^"]+)"', a).group(1).rstrip('/') == me.rstrip('/')]
        marked = [a for a in links if 'aria-current="page"' in a]
        if mine and not marked:
            findings.append(f'{rel}: the nav links to this page ({me}) and nothing carries '
                            f'aria-current="page", so the current entry is not marked')
        elif len(marked) > 1:
            findings.append(f'{rel}: {len(marked)} nav links carry aria-current="page"; exactly one may')
        elif marked and mine and marked[0] not in mine:
            href = re.search(r'href="([^"]+)"', marked[0])
            findings.append(f'{rel}: aria-current="page" is on {href.group(1) if href else "?"}, '
                            f'but this page is served at {me}')


def main() -> int:
    pages = sorted(SITE.glob('*.html'))
    if not pages:
        print('No pages found.', file=sys.stderr)
        return 2
    # One shape per *language*. The chrome must not change as you move through a site; it must change
    # when you change language, because the labels are the point of translating it.
    groups = {'en': pages, 'it': sorted((SITE / 'it').glob('*.html'))}

    findings = []
    for lang, group in groups.items():
        if not group:
            continue
        for name, fn in (('navigation', nav_shape), ('footer', footer_shape)):
            shapes = {}
            for p in group:
                s = fn(p.read_text(encoding='utf-8'))
                if s is None:
                    findings.append(f'{p.name}: no {name} at all')
                    continue
                shapes.setdefault(repr(s), []).append(p.name)
            if len(shapes) > 1:
                findings.append(f'The {name} has {len(shapes)} different shapes in {lang}:')
                for shape, files in sorted(shapes.items(), key=lambda kv: -len(kv[1])):
                    findings.append(f'    {", ".join(files)}')
                    findings.append(f'      {shape[:300]}')

    # The naming rules are about the *products*, not about English: a bare «Analytics» in Italian prose
    # says exactly as little about whose product it is.
    for p in pages + groups['it']:
        for ctx in bare_platform(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: bare platform name — …{ctx}…')
        for lbl in ours_named_as_theirs(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: our product labelled with Zoho\'s name — {lbl}')
        for form in undeclared_form(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: {form!r} is neither the manifest name nor its short_name')

    for doc in outward_prose():
        check_prose(doc, findings)

    store_field_limits(findings)
    classes_defined(findings)
    anchors_resolve(findings)
    translations_link_to_translations(findings)
    shared_prose_stays_shared(findings)
    canonical_and_alternates(findings)
    translations_current(findings)
    trademark_disclaimer_is_one_sentence(findings)
    stamps_are_derived(findings)
    no_date_is_typed(findings)
    nav_targets_match_across_languages(findings)
    nav_marks_the_page_you_are_on(findings)
    txt_served_by_worker(findings)
    hosts_declared(findings)
    data_centre_count_is_derived(findings)
    file_count_is_derived(findings)
    translations_have_the_same_shape(findings)

    # The site's own scripts build visible text — the footer badge's product labels live in
    # site.js, not in any page — and nothing was reading them. The fourth form reappeared there
    # within the hour, invisible to a check that stopped at .html.
    for js in sorted(SITE.glob('*.js')):
        src = js.read_text(encoding='utf-8')
        src = re.sub(r'^\s*//.*$', ' ', src, flags=re.M)      # comments discuss the rule, they do not state it
        src = re.sub(r'/\*.*?\*/', ' ', src, flags=re.S)
        for form in undeclared_form(src):
            findings.append(f'{js.name}: {form!r} is neither the manifest name nor its short_name')

    print(f'sitecheck: {len(pages)} pages — ' + ', '.join(p.name for p in pages))
    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). The chrome must look the same on every page; only targets may differ.'
          if findings else
          '0 findings. Header and footer have one shape across the site.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
