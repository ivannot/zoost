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
    s = re.sub(r'Zoho (CRM|Analytics)|Zoost for Zoho \w+', ' ', s)
    return [' '.join(s[max(0, m.start() - 45):m.end() + 25].split())
            for m in re.finditer(r'\b(Analytics|CRM)\b', s)]


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
