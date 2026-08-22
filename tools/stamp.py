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
import hashlib
import os
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
    because the file *has* changed - the same rule sitemap.py applies to <lastmod>.

    **Both branches are UTC**, and that is the whole of the second paragraph. They were not: `today`
    was UTC while `%cs` prints the committer's own recorded offset, so within one evening the check
    said «says 22, it is 23» before a commit and «says 23, it is 22» after one, and the battery could
    not converge at all in the hours around midnight - which is exactly when CI last went red for a
    date nobody had changed. Two clocks compared as one, the class this repository has met at every
    boundary it has: pick one and read both sides through it. UTC rather than local, because a page
    stamped by the machine that happened to run the tool is a value that moves when nothing has.
    """
    p = ROOT / rel
    dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--', str(p)],
                           capture_output=True, text=True).stdout.strip()
    today = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    if dirty:
        return today
    return subprocess.run(['git', '-C', str(ROOT), 'log', '-1', '--format=%cd',
                           '--date=format-local:%Y-%m-%d', '--', str(p)],
                          capture_output=True, text=True,
                          env={**os.environ, 'TZ': 'UTC'}).stdout.strip() or today


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


# Assets are cached for a week and their names carry no hash, so the same URL served different
# bytes: a reader who had seen a page before the diagram window was renamed went on being shown
# «Functions» where it now says «Wiring», for up to seven days. Reported. The token is the asset's
# **own digest**, per asset - a release number would leave anything that changed between releases
# serving the old copy, which is this bug again with a slower fuse.
#
# A query string rather than a new filename: the browser keys on the whole URL, so it busts, while
# the file keeps one name - nothing accumulates orphans and `og:image` stays a clean URL. And it is
# what lets `site.css` and `site.js` be cached at all: they were deliberately left on a short cache
# because a returning reader could otherwise pair new HTML with an old stylesheet.
# `ico` and `svg` were missing, and the favicon is the one asset that most needed them: the mark was
# redrawn and every URL on the site changed except that one, so anything holding the old bytes had no
# signal to refetch. The rule this file exists for - a picture that changed is a URL that changed -
# was not applied to the picture people see first. It is not a complete cure, because a browser asks
# for `/favicon.ico` by itself and ignores the `<link>`, but the inconsistency was ours.
ASSET = re.compile(r'(?:src|href)="/((?:img/)?[\w.-]+\.(?:webp|png|ico|svg|css|js))(\?v=[0-9a-f]+)?"')
# The web manifest names two icons and is not HTML, so nothing here had ever looked at it.
MANIFEST_ICON = re.compile(r'"src":\s*"/([\w.-]+\.(?:png|svg|ico))(\?v=[0-9a-f]+)?"')
# The card a link unfurls into is the same problem one attribute over: `og:image` is an absolute URL
# in a `content=`, read by scrapers that cache by URL, so a card that changes and keeps its address
# is a card nobody sees change. Only asset extensions match, which is why `og:url` - a page - is not
# touched by this.
OG = re.compile(r'content="(https://zoost\.it/((?:img/)?[\w.-]+\.(?:webp|png)))(\?v=[0-9a-f]+)?"')


def asset_token(rel: str) -> str:
    f = SITE / rel
    return hashlib.sha256(f.read_bytes()).hexdigest()[:10] if f.exists() else ''


def stamp_assets(check: bool = False) -> list:
    """Rewrite every asset URL on every page with that asset's digest. Returns what was behind."""
    behind = []
    for page in sorted(SITE.rglob('*.html')):
        html = page.read_text(encoding='utf-8')

        def one(m):
            rel, had, tok = m.group(1), m.group(2) or '', asset_token(m.group(1))
            if not tok or had == f'?v={tok}':
                return m.group(0)
            behind.append(f'site/{page.relative_to(SITE)}: /{rel} is stamped {had[3:] or "(not at all)"}, '
                          f'its bytes hash to {tok}')
            return m.group(0).replace(m.group(1) + had, f'{rel}?v={tok}')

        def og(m):
            rel, had, tok = m.group(2), m.group(3) or '', asset_token(m.group(2))
            if not tok or had == f'?v={tok}':
                return m.group(0)
            behind.append(f'site/{page.relative_to(SITE)}: og:image /{rel} is stamped '
                          f'{had[3:] or "(not at all)"}, its bytes hash to {tok}')
            return f'content="{m.group(1)}?v={tok}"'

        out = OG.sub(og, ASSET.sub(one, html))
        if out != html and not check:
            page.write_text(out, encoding='utf-8')

    # The manifest is JSON, so it went through none of the above and its two icons carried no digest
    # at all. Same rule, one file, its own pattern rather than a second copy of the logic.
    mf = SITE / 'site.webmanifest'
    if mf.exists():
        text = mf.read_text(encoding='utf-8')

        def icon(m):
            rel, had, tok = m.group(1), m.group(2) or '', asset_token(m.group(1))
            if not tok or had == f'?v={tok}':
                return m.group(0)
            behind.append(f'site/site.webmanifest: /{rel} is stamped {had[3:] or "(not at all)"}, '
                          f'its bytes hash to {tok}')
            return f'"src": "/{rel}?v={tok}"'

        out = MANIFEST_ICON.sub(icon, text)
        if out != text and not check:
            mf.write_text(out, encoding='utf-8')
    return behind


def pages() -> list:
    return sorted(str(p.relative_to(SITE)) for p in SITE.rglob('*.html')
                  if 'data-stamp="' in p.read_text(encoding='utf-8'))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='report drift instead of writing')
    args = ap.parse_args()

    assets = stamp_assets(check=args.check)
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
        if not drift and not assets:
            print(f'{n} stamp(s) across {len(found)} page(s) are what the systems say they are, '
                  f'and every asset URL carries its own digest')
            return 0
        for a in assets:
            print(f'  {a} - run: python3 tools/stamp.py')
        print(f'{len(drift)} stamp(s) not derived - run: python3 tools/stamp.py')
        for rel, kind, was, now in drift:
            print(f'  site/{rel}: {kind} says "{was}", it is "{now}"')
        return 1
    print(f'{n} stamp(s) across {len(found)} page(s); {written} page(s) rewritten; '
          f'{len(assets)} asset URL(s) restamped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
