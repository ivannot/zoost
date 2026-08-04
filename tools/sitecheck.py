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
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / 'site'

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
    s = re.sub(r'Zoost for Zoho (CRM|Analytics)|Zoho (CRM|Analytics)|Zoost (CRM|Analytics)', ' ', s)
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
    found = re.findall(r'Zoost(?:\s*[—-]\s*)?(?:\s+\w+){0,3}?\s+(?:Zoho\s+)?(?:CRM|Analytics)', s)
    return sorted({f.strip() for f in found if f.strip() not in ok})


def main() -> int:
    pages = sorted(SITE.glob('*.html'))
    if not pages:
        print('No pages found.', file=sys.stderr)
        return 2

    findings = []
    for name, fn in (('navigation', nav_shape), ('footer', footer_shape)):
        shapes = {}
        for p in pages:
            s = fn(p.read_text(encoding='utf-8'))
            if s is None:
                findings.append(f'{p.name}: no {name} at all')
                continue
            shapes.setdefault(repr(s), []).append(p.name)
        if len(shapes) > 1:
            findings.append(f'The {name} has {len(shapes)} different shapes:')
            for shape, files in sorted(shapes.items(), key=lambda kv: -len(kv[1])):
                findings.append(f'    {", ".join(files)}')
                findings.append(f'      {shape[:300]}')

    for p in pages:
        for ctx in bare_platform(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: bare platform name — …{ctx}…')
        for lbl in ours_named_as_theirs(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: our product labelled with Zoho\'s name — {lbl}')
        for form in undeclared_form(p.read_text(encoding='utf-8')):
            findings.append(f'{p.name}: {form!r} is neither the manifest name nor its short_name')

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
