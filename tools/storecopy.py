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
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The fenced body is named because a second reader depends on it: `auditcheck` reads absolute claims
# out of `(?P<body>...)` and nothing else in these files, so the fence is the boundary between what is
# published and what we write to ourselves. A name is additive - it is still group 4 to the code below.
# The fenced body of a section - the text somebody retypes into a dashboard box. Kept fenced-only,
# because `auditcheck` imports it to ask «is there a fence here», and a pattern that also matched a
# blockquote would answer yes to a different question. The other body shape is handled in sections().
SECTION = re.compile(r'^## (\d+)\. ([^\n]+?)(?: \(max (\d+)\))?\n\n```\n(?P<body>.*?)\n```', re.S | re.M)
# Every numbered heading, whatever follows it. The denominator, so a section in a shape sections()
# cannot read is a finding about the tool rather than a silence - `tests/tools_test.py` derives the
# same set from the file by a cruder route and compares.
HEADING = re.compile(r'^## (\d+)\. ([^\n]+?)(?: \(max (\d+)\))?$', re.M)


def clipboard() -> list:
    """pbcopy on macOS, clip.exe under WSL, xclip or wl-copy on Linux. One field at a time is pasted
    into a browser form, so the clipboard is the point of the tool and not a convenience."""
    import shutil
    for cmd in (['pbcopy'], ['clip.exe'], ['xclip', '-selection', 'clipboard'], ['wl-copy']):
        if shutil.which(cmd[0]):
            return cmd
    sys.exit('no clipboard tool found - drop --copy and pipe the output yourself')


def sections(app: str):
    f = ROOT / 'store' / app / 'store-listing.md'
    if not f.exists():
        sys.exit(f'no store copy for {app}')
    text = f.read_text(encoding='utf-8')
    heads = list(HEADING.finditer(text))
    out = []
    for k, h in enumerate(heads):
        chunk = text[h.end():heads[k + 1].start() if k + 1 < len(heads) else len(text)]
        fence = re.search(r'```\n(.*?)\n```', chunk, re.S)
        if fence:
            body = fence.group(1)
        else:
            # Section 10 is the data disclosure: a table of checkboxes and one blockquote, the
            # sentence Google is told about what leaves the machine. No fence, so the old parser
            # walked past the heading and `--changed`, `digests` and `dashcheck` never saw it. It
            # drifted for two days in the CRM listing, still saying «Nothing is sent to the
            # developer» after the problem report shipped, and the sweep that corrected its twin
            # missed it for the same reason: nothing was comparing it.
            quote = re.search(r'((?:^>[^\n]*\n)+)', chunk, re.M)
            if not quote:
                continue        # a heading with neither shape: the test derives it and reports it
            body = '\n'.join(l[2:] if l.startswith('> ') else l[1:]
                              for l in quote.group(1).strip().split('\n'))
        out.append((int(h.group(1)), h.group(2), int(h.group(3)) if h.group(3) else None, body))
    return out


def digests(app: str) -> dict:
    """Each section's text, hashed. Recorded at submission and compared before the next one."""
    return {str(n): hashlib.sha256(body.encode()).hexdigest()[:12] for n, _, _, body in sections(app)}


def changed(app: str) -> int:
    """Which boxes in the dashboard actually need touching this time.

    The upload of a package can be automated and the *listing* cannot - Google exposes no endpoint
    for the description, the justifications or the screenshots, so somebody retypes them by hand. The
    tedium is not the pasting, though: it is opening nine boxes to find out which two moved. That
    part is derivable, so it is derived - `store/<app>/listing.json` records what each section looked
    like when it was last submitted.
    """
    led = ROOT / 'store' / app / 'listing.json'
    was = json.loads(led.read_text(encoding='utf-8')).get('sections', {}) if led.exists() else {}
    if not was:
        print(f'{app}: nothing recorded as submitted yet - every field is unknown, treat all as new.')
        print(f'  after the next submission: python3 tools/submitted.py {app}')
        return 0
    moved = [(n, name, cap, body) for n, name, cap, body in sections(app)
             if was.get(str(n)) != hashlib.sha256(body.encode()).hexdigest()[:12]]
    if not moved:
        print(f'{app}: every store field is what was submitted for {json.loads(led.read_text(encoding="utf-8")).get("version", "?")} - nothing to paste.')
    for n, name, cap, _ in moved:
        print(f'  §{n} {name} - changed. python3 tools/storecopy.py {app} {n} --copy')
    shots = ROOT / 'store' / app / 'screenshots.json'
    if shots.exists():
        j = json.loads(shots.read_text(encoding='utf-8'))
        print(f'  screenshots: recorded for {j.get("version", "?")} - run tools/shots.py to see if they moved')
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[0])
    app = sys.argv[1]
    if '--changed' in sys.argv:
        return changed(app)
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
            subprocess.run(clipboard(), input=body, text=True, check=True)
            print(f'{name}: {len(body)} chars on the clipboard'
                  + (f' (max {cap})' if cap else ''))
        else:
            print(body)
        return 0
    sys.exit(f'{app} has no section {want}')


if __name__ == '__main__':
    sys.exit(main())
