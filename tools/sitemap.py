#!/usr/bin/env python3
"""
sitemap.py — write site/sitemap.xml from the site itself.

    python3 tools/sitemap.py            # rewrite it
    python3 tools/sitemap.py --check    # report a difference, change nothing

Every field here used to be typed by hand, and the dates had drifted three days behind on 15 of the
17 URLs while two carried none at all. That is not cosmetic. Google's own documentation says it uses
`<lastmod>` "if it's consistently and verifiably accurate (for example by comparing to the last
modification of the page)" — so a file whose dates do not survive that comparison does not merely
lose one row, it loses the field. The one moment that mattered was the one where it was wrong: the
canonical fix had just rewritten every page and the sitemap was still saying nothing had changed.

Three things are derived, and nothing is authored:

  * **the URL**, by the same rule as `auditcheck.published_path()` — Cloudflare serves `crm.html` at
    `/crm` and `it/index.html` at `/it/`, and writing the file's own path here is exactly the mistake
    that made every canonical on this site point at a redirect;
  * **`lastmod`**, from the last commit that touched that file — verifiable, which is the property
    Google asks for. A file with uncommitted changes takes today, because it is being changed today
    and the alternative is a sitemap permanently one commit behind;
  * **the `hreflang` pair**, from whether the translation exists, so a page added tomorrow carries
    its alternates without anyone remembering.

`<priority>` and `<changefreq>` are **not** written. Google's documentation says plainly that it
ignores both, and a hand-maintained field nobody reads is a field that can only ever be wrong — this
one already was, with `/how-to` carrying none while its Italian twin carried 0.4.
"""
import argparse
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
BASE = 'https://zoost.it'

# Anything served that is worth pointing a crawler at. `llms.txt` is here because it is a document
# with a reader, not an asset; the stylesheet and the icons are not.
EXTRA = ('llms.txt',)


def url_of(rel: str) -> str:
    """Repository path under site/ → the URL it is served at. Same rule as published_path()."""
    if rel.endswith('index.html'):
        return f'{BASE}/{rel[:-len("index.html")]}'
    return f'{BASE}/{rel[:-5]}' if rel.endswith('.html') else f'{BASE}/{rel}'


def lastmod(rel: str) -> str:
    p = SITE / rel
    dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--', str(p)],
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        return datetime.now(timezone.utc).strftime('%Y-%m-%d')
    out = subprocess.run(['git', '-C', str(ROOT), 'log', '-1', '--format=%cs', '--', str(p)],
                         capture_output=True, text=True).stdout.strip()
    return out or datetime.now(timezone.utc).strftime('%Y-%m-%d')


def pages() -> list:
    """Each English page followed by its translation, home first.

    Order means nothing to a crawler and something to whoever opens the file: sorting purely by name
    buries `/` between how-to and nerd, which reads as though the site had no front door.
    """
    out = []
    for p in sorted(SITE.glob('*.html'), key=lambda x: (x.name != 'index.html', x.name)):
        if p.name == '404.html':      # served everywhere, addressed nowhere, and carries noindex
            continue
        out.append(p.relative_to(SITE).as_posix())
        twin = SITE / 'it' / p.name
        if twin.exists():
            out.append(twin.relative_to(SITE).as_posix())
    return out


def build() -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
             '        xmlns:xhtml="http://www.w3.org/1999/xhtml">']
    for rel in pages() + [e for e in EXTRA if (SITE / e).exists()]:
        lines.append('  <url>')
        lines.append(f'    <loc>{url_of(rel)}</loc>')
        lines.append(f'    <lastmod>{lastmod(rel)}</lastmod>')
        name = rel.split('/')[-1]
        if rel.endswith('.html') and (SITE / name).exists() and (SITE / 'it' / name).exists():
            lines.append(f'    <xhtml:link rel="alternate" hreflang="en" href="{url_of(name)}"/>')
            lines.append(f'    <xhtml:link rel="alternate" hreflang="it" href="{url_of("it/" + name)}"/>')
        lines.append('  </url>')
    lines.append('</urlset>')
    return '\n'.join(lines) + '\n'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='report a difference instead of writing')
    args = ap.parse_args()

    want, f = build(), SITE / 'sitemap.xml'
    have = f.read_text(encoding='utf-8') if f.exists() else ''
    if args.check:
        if want == have:
            print(f'sitemap.xml is what the site says it should be ({want.count("<url>")} URLs)')
            return 0
        print('sitemap.xml is not what the site says it should be — run: python3 tools/sitemap.py')
        import difflib
        for line in list(difflib.unified_diff(have.split('\n'), want.split('\n'),
                                              'committed', 'derived', lineterm=''))[:40]:
            print('  ' + line)
        return 1
    f.write_text(want, encoding='utf-8')
    print(f'sitemap.xml: {want.count("<url>")} URLs written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
