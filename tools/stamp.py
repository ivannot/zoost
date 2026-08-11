#!/usr/bin/env python3
"""Every date and version printed on the site, written from the systems that hold them.

    python3 tools/stamp.py            # rewrite the stamps
    python3 tools/stamp.py --check    # report drift instead (this is what the suite runs)

A date typed into a file is a claim nobody can check, and it can disagree with the record it claims
to describe - the point the author made about `RELEASES.md` carrying submission dates beside the
tags GitHub already timestamps. So nothing here is typed: the version comes from the app's own
`manifest.json`, the date from the last commit that touched the page, and both are re-derivable at
any moment. The same discipline as `tools/sitemap.py`, which derives `<lastmod>` for the same reason.

The stamps the browser fills from `/api/versions` are the *same values from the same systems* - the
version off `manifest.json` on `main`, the date off the commits feed - so what a reader with no
scripts sees is what a reader with scripts sees. What this tool provides is that first reader, who
is the one an assistant reading `zoost.it` always is.

**A stamped element declares itself** with `data-stamp`, and that is what makes the check possible:
`sitecheck.py` reports a date anywhere in outward prose that is not inside one. Adding a stamp is
therefore declaring it where it lives, and forgetting is reported rather than silently allowed.

Two rules that are not arbitrary:

  * The date of a **translation** is its original's. `site/it/docs-crm.html` is dated by
    `site/docs-crm.html`, read from the `translated-from` marker the page already carries - which is
    also what the runtime does, so the two cannot disagree. Dating the Italian by its own commit
    would make a page claim to have changed when only its translation was corrected.
  * The version is the one in the **repository**, not the one on the Store: documentation ships with
    the code that changed it. site.js adds "the Store is serving X" when the two differ; a static
    fallback cannot know that, and saying less is better than saying something that will go stale.
"""
import argparse
import datetime
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'

MONTHS = {
    'en': ['January', 'February', 'March', 'April', 'May', 'June',
           'July', 'August', 'September', 'October', 'November', 'December'],
    'it': ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
           'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
}
STAMP = re.compile(r'(<(\w+)([^>]*\bdata-stamp="([^"]+)"[^>]*)>)(.*?)(</\2>)')
TRANSLATED = re.compile(r'<!--\s*translated-from:\s*(\S+)')


def git_date(rel: str) -> str:
    """The last commit that touched a path, as YYYY-MM-DD. Uncommitted changes read as today,
    because the file *has* changed - the same rule sitemap.py applies to <lastmod>."""
    p = ROOT / rel
    dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--', str(p)],
                           capture_output=True, text=True).stdout.strip()
    today = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    if dirty:
        return today
    return subprocess.run(['git', '-C', str(ROOT), 'log', '-1', '--format=%cs', '--', str(p)],
                          capture_output=True, text=True).stdout.strip() or today


def manifest_version(app: str) -> str:
    m = re.search(r'"version"\s*:\s*"([^"]+)"',
                  (ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
    return m.group(1) if m else ''


def long_date(iso: str, lang: str) -> str:
    y, m, d = iso.split('-')
    return f'{int(d)} {MONTHS.get(lang, MONTHS["en"])[int(m) - 1]} {y}'


def source_of(rel: str, html: str) -> str:
    """Which file's history dates this page - its own, or its original's if it is a translation.

    The marker holds a repository path (`site/docs-crm.html`) while `rel` is relative to `site/`, and
    conflating the two asked git about a file that does not exist: it answers with an empty string
    rather than an error, so the first version failed several frames later on a date it never had."""
    m = TRANSLATED.search(html)
    return m.group(1) if m else f'site/{rel}'


def value(kind: str, rel: str, html: str, open_tag: str) -> str:
    lang = 'it' if re.search(r'<html[^>]*\blang="it"', html) else 'en'
    if kind == 'updated':
        return long_date(git_date(source_of(rel, html)), lang)
    if kind == 'version':
        # Which product this page documents is already declared on the paragraph around it: a guide
        # that borrowed the other product's number would state something false about its subject.
        line = html[:html.index(open_tag)].rsplit('<p', 1)[-1] if '<p' in html else ''
        m = re.search(r'data-app="(\w+)"', line)
        return manifest_version(m.group(1) if m else 'crm')
    raise SystemExit(f'{rel}: unknown stamp kind "{kind}"')


def stamped(rel: str) -> tuple:
    """(new text, [(kind, was, now)]) for one page."""
    html = (SITE / rel).read_text(encoding='utf-8')
    changes = []

    def one(m):
        open_tag, _tag, _attrs, kind, inner, close = m.groups()
        want = value(kind, rel, html, open_tag)
        if want and want != inner:
            changes.append((kind, inner, want))
        return open_tag + (want or inner) + close

    return STAMP.sub(one, html), changes


def pages() -> list:
    return sorted(str(p.relative_to(SITE)) for p in SITE.rglob('*.html')
                  if 'data-stamp="' in p.read_text(encoding='utf-8'))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='report drift instead of writing')
    args = ap.parse_args()

    found = pages()
    if not found:
        print('no stamped element anywhere under site/ - has data-stamp been renamed?')
        return 1
    drift, written = [], 0
    for rel in found:
        text, changes = stamped(rel)
        if not changes:
            continue
        drift.extend((rel, *c) for c in changes)
        if not args.check:
            (SITE / rel).write_text(text, encoding='utf-8')
            written += 1

    n = sum(1 for rel in found for _ in STAMP.finditer((SITE / rel).read_text(encoding='utf-8')))
    if args.check:
        if not drift:
            print(f'{n} stamp(s) across {len(found)} page(s) are what the systems say they are')
            return 0
        print(f'{len(drift)} stamp(s) not derived - run: python3 tools/stamp.py')
        for rel, kind, was, now in drift:
            print(f'  site/{rel}: {kind} says "{was}", it is "{now}"')
        return 1
    print(f'{n} stamp(s) across {len(found)} page(s); {written} page(s) rewritten')
    return 0


if __name__ == '__main__':
    sys.exit(main())
