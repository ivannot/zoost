#!/usr/bin/env python3
"""One dashboard box, on the clipboard: python3 tools/storecopy.py <app> <n>

The Chrome Web Store dashboard is a column of textareas, and every release means pasting some of
them again. Reading a section out of `store/<app>/store-listing.md` by eye means scrolling past nine
thousand characters of detailed description to find the one that moved, and selecting it by hand -
which is how a paste ends up with a stray line or half a paragraph.

    python3 tools/storecopy.py crm            # what the sections are, how long, and their limit
    python3 tools/storecopy.py crm 9          # print section 9
    python3 tools/storecopy.py crm 9 --copy   # and put it on the clipboard instead

The numbering is the file's own (`## 9. Host permission justification`), not the dashboard's, because
the dashboard numbers nothing and its order is not ours to guess. It also prints the character count
against the limit written in the heading: a submission that stops at the form costs two or three days.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SECTION = re.compile(r'^## (\d+)\. ([^\n]+?)(?: \(max (\d+)\))?\n\n```\n(.*?)\n```', re.S | re.M)


def sections(app: str):
    f = ROOT / 'store' / app / 'store-listing.md'
    if not f.exists():
        sys.exit(f'no store copy for {app}')
    return [(int(m.group(1)), m.group(2), int(m.group(3)) if m.group(3) else None, m.group(4))
            for m in SECTION.finditer(f.read_text(encoding='utf-8'))]


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[0])
    app = sys.argv[1]
    found = sections(app)
    if len(sys.argv) < 3:
        for n, name, cap, body in found:
            over = cap and len(body) > cap
            print(f'{n}. {name:<44} {len(body):>5} chars'
                  + (f'  (max {cap}){"  OVER THE LIMIT" if over else ""}' if cap else ''))
        return 0
    want = int(sys.argv[2])
    for n, name, cap, body in found:
        if n != want:
            continue
        if '--copy' in sys.argv:
            subprocess.run(['pbcopy'], input=body, text=True, check=True)
            print(f'{name}: {len(body)} chars on the clipboard'
                  + (f' (max {cap})' if cap else ''))
        else:
            print(body)
        return 0
    sys.exit(f'{app} has no section {want}')


if __name__ == '__main__':
    sys.exit(main())
