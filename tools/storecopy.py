#!/usr/bin/env python3
"""One dashboard box, on the clipboard: python3 tools/storecopy.py <app> <n>

The Chrome Web Store dashboard is a column of textareas, and every release means pasting some of
them again. Reading a section out of `store/<app>/store-listing.md` by eye means scrolling past nine
thousand characters of detailed description to find the one that moved, and selecting it by hand -
which is how a paste ends up with a stray line or half a paragraph.

    python3 tools/storecopy.py crm            # what the sections are, how long, and their limit
    python3 tools/storecopy.py crm 9          # print section 9 (its box name also works)
    python3 tools/storecopy.py crm tabs-justification --copy   # onto the clipboard instead
    python3 tools/storecopy.py all --files    # one file per box, named as the dashboard names it

The numbering is the file's own (`## 9. Host permission justification`), not the dashboard's, because
the dashboard numbers nothing and its order is not ours to guess. It also prints the character count
against the limit written in the heading: a submission that stops at the form costs two or three days.
"""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APPS = ('crm', 'analytics')
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
HEADING = re.compile(r'^## (\d+)\. ([^\n]+?)$', re.M)
# The ceiling, wherever the heading states it. It used to be read only as ` (max N)` closing the
# heading, which is how §2 - `## 2. Short description (manifest `description`, max 132)` - was printed
# with no limit at all for as long as this tool has existed: the one field with five characters of
# headroom, and the only one where a paste is refused by the form rather than by a reader. `sitecheck`
# had it right (`max (\d+)\)` anywhere) and this file did not, which is two readings of one heading.
CEILING = re.compile(r'max (\d+)\)')


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
        cap = CEILING.search(h.group(2))
        # The ceiling is ours to state and not part of the box's name, so it leaves the name with it.
        name = CEILING.sub(')', h.group(2)).replace(', )', ')').replace(' ()', '').rstrip()
        out.append((int(h.group(1)), name, int(cap.group(1)) if cap else None, unwrap(body)))
    return out


def unwrap(body: str) -> str:
    """The text as the dashboard should receive it: no line break inside a sentence, none at the end.

    The source wraps at about a hundred characters because a file nobody can read is a file nobody
    corrects. The *field* has no such shape - it is one box, and a break in the middle of a sentence
    arrives as a break in the middle of a sentence. Reported after a submission: «ci sono degli a
    capo in mezzo alla frase ... l'ultimo carattere del testo non deve essere un a capo».

    The rule is about the *reason* a line ended, not about line endings. A blank line is a paragraph
    boundary; a line opening a list item, a table row, a quote or a heading starts a new one of those.
    Every other line is the wrapping, and belongs to whatever it is continuing - which is why a
    structure line **opens** a buffer here rather than being emitted on its own: a bullet long enough
    to wrap would otherwise keep the break this function exists to remove, in the one shape nobody
    would look at again. No section wraps a bullet today; the day one does, it is already handled.
    """
    out, buf = [], []

    def flush():
        if buf:
            out.append(' '.join(x.strip() for x in buf))
            buf.clear()

    for line in body.split('\n'):
        stripped = line.strip()
        if not stripped:
            flush()
            out.append('')
        elif stripped[0] in '-*|>#' or (stripped.split('.')[0].isdigit() and stripped[1:3] in ('. ', ') ')):
            flush()
            buf.append(line)
        else:
            buf.append(line)
    flush()
    # A trailing newline is not part of the text: it is how a file ends, and this is not a file.
    return '\n'.join(out).rstrip('\n')


def digests(app: str) -> dict:
    """Each section's text, hashed, under the name of the box it is pasted into.

    **Never the section number.** It was, and the first release that removed a permission proved why:
    `sidePanel` left both manifests, its justification left this file, and everything after it moved
    up one - so the record said five boxes had drifted in each product when the true answer was one.
    Four of the five would have been retyped for nothing, and the one that mattered was indoors among
    them. An ordinal is a position in a list that changes; the box name is the thing itself, and it is
    already derived here for the filenames (`box()`), on his rule that the number is misleading.
    """
    return {box(name): hashlib.sha256(body.encode()).hexdigest()[:12]
            for _n, name, _cap, body in sections(app)}


def changed_sections(app: str) -> list:
    """Which sections differ from what was last pasted, as a list of numbers. Empty when nothing has.

    Split out of `changed()` so a caller can *ask* rather than parse printed lines: `auditcheck`
    reports this at the end of a piece of work, which is where it gets read. An unrecorded listing
    answers `[]` and not «everything» - «nobody has submitted yet» is not «everything drifted», and
    the difference is what the printed version says in its own words.
    """
    led = ROOT / 'store' / app / 'listing.json'
    was = json.loads(led.read_text(encoding='utf-8')).get('sections', {}) if led.exists() else {}
    if not was:
        return []
    return [box(name) for _n, name, _cap, body in sections(app)
            if was.get(box(name)) != hashlib.sha256(body.encode()).hexdigest()[:12]]


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
             if was.get(box(name)) != hashlib.sha256(body.encode()).hexdigest()[:12]]
    if not moved:
        print(f'{app}: every store field is what was submitted for {json.loads(led.read_text(encoding="utf-8")).get("version", "?")} - nothing to paste.')
    for _n, name, cap, _ in moved:
        print(f'  {name} - changed. python3 tools/storecopy.py {app} {box(name)} --copy')
    shots = ROOT / 'store' / app / 'screenshots.json'
    if shots.exists():
        j = json.loads(shots.read_text(encoding='utf-8'))
        print(f'  screenshots: recorded for {j.get("version", "?")} - run tools/shots.py to see if they moved')
    return 0


def box(name: str) -> str:
    """The filename of a field, taken from the box the dashboard puts it in.

    Never our section number. «Il numero progressivo e' fuorviante: voglio che le descrizioni siano
    riferite al nome del box» - said after receiving ten files called `crm-1.txt` .. `crm-10.txt` and
    a note explaining which number meant what, which is a translation step performed while looking at
    a form. The heading already carries the name; the parenthetical after it is ours (`(max 1000)`,
    `(manifest `description`)`) and is dropped.
    """
    return re.sub(r'[^a-z0-9]+', '-', name.split('(')[0].strip().lower()).strip('-')


def write_files(dest: pathlib.Path, apps=APPS) -> int:
    """One file per dashboard box, under `<dest>/<app>/texts/`, plus an index at the root.

    **The shape is fixed and it is his**, asked for on 21 September 2026 after three handovers had
    invented three layouts: `store/` holds a folder per product, each holding `images/` (written by
    `shots.py`) and `texts/` (written here), and a text is named after its box with no number and no
    product prefix - the product is the folder it is in. It is written into `dist/store/` so that the
    one rsync in `tools/totest.sh` carries the pictures and the fields together, and so `synctest.sh`
    - which already watches `dist/store` - puts them on the other machine without being asked.

    This existed as a handful of shell commands typed once, which is the step this repository says
    will be done wrong the second time. It is here so the names, the character counts and the list of
    what actually moved are derived rather than retyped - and so the text lands in the file the way
    the box wants it, which is what `unwrap` above is for.

    Only what differs is written: the far side of that folder is watched by a sync client, and
    rewriting twenty identical files on every run is twenty events about nothing.
    """
    dest.mkdir(parents=True, exist_ok=True)
    wrote, index, count, gone = 0, [], 0, []
    for app in apps:
        ver = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))['version']
        moved = set(changed_sections(app))
        index.append(f'\nZOOST {"CRM" if app == "crm" else "ANALYTICS"} {ver}')
        texts = dest / app / 'texts'
        texts.mkdir(parents=True, exist_ok=True)
        current = set()
        for _n, name, cap, body in sections(app):
            f = texts / f'{box(name)}.txt'
            current.add(f.name)
            # No trailing newline: the last character of the text is the last character of the text.
            # A file conventionally ends in one, and that convention travels into the box.
            if not f.exists() or f.read_text(encoding='utf-8') != body:
                f.write_text(body, encoding='utf-8')
                wrote += 1
            size = f'{len(body)} of {cap}' if cap else f'{len(body)} chars'
            index.append(f'  {app}/texts/{f.name:<44} {name}  ({size})'
                         + ('  <- CHANGED since it was last pasted' if box(name) in moved else ''))
            count += 1
        # **A box that no longer exists leaves no file behind.** Removing the `sidePanel` permission
        # took its justification out of the listing and left `sidepanel-justification.txt` sitting in
        # the folder he opens to paste from - a field the dashboard no longer has, indistinguishable
        # from the ones it does. This folder is the handover, so it holds what is to be pasted and
        # nothing else.
        for stale in texts.glob('*.txt'):
            if stale.name not in current:
                stale.unlink()
                gone.append(f'{app}/texts/{stale.name}')
    readme = ('The Web Store fields, one file per box, named as the dashboard names them.\n'
              f'Written {datetime.date.today().strftime("%-d %B %Y")} from store/<app>/store-listing.md.\n'
              '\nEach file holds exactly what goes in the box: no line break inside a sentence, and\n'
              'no newline at the end. Paste the whole file.\n'
              + '\n'.join(index) + '\n')
    (dest / 'READ-ME-FIRST.txt').write_text(readme, encoding='utf-8')
    # Counted, not multiplied by a number typed here: the listing had ten sections and has nine, and
    # `len(apps) * 10` went on claiming the old one for as long as nobody looked.
    print(f'{dest}: {count} box file(s), {wrote} written, the rest already in step'
          + (f'; removed {", ".join(gone)}' if gone else ''))
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[0])
    app = sys.argv[1]
    if '--files' in sys.argv:
        rest = [a for a in sys.argv[2:] if not a.startswith('--')]
        # `dist/` by default, not the mirror: that is where the deliverables for a submission live,
        # it is what `totest.sh` and `synctest.sh` already carry across, and it means this tool has
        # no opinion about which machine has the dashboard open.
        where = rest[0] if rest else str(ROOT / 'dist')
        return write_files(pathlib.Path(where) / 'store',
                           APPS if app == 'all' else (app,))
    if '--changed' in sys.argv:
        return changed(app)
    found = sections(app)
    if len(sys.argv) < 3:
        for n, name, cap, body in found:
            over = cap and len(body) > cap
            print(f'{n}. {name:<44} {len(body):>5} chars'
                  + (f'  (max {cap}){"  OVER THE LIMIT" if over else ""}' if cap else ''))
        return 0
    # A box is asked for by its name or by its number. The name is what the record and the printed
    # lines use, because it survives a section being removed; the number is what the file shows and
    # what a reader has in front of them, so both answer.
    want = sys.argv[2]
    for n, name, cap, body in found:
        if str(n) != want and box(name) != want:
            continue
        if '--copy' in sys.argv:
            subprocess.run(clipboard(), input=body, text=True, check=True)
            print(f'{name}: {len(body)} chars on the clipboard'
                  + (f' (max {cap})' if cap else ''))
        else:
            print(body)
        return 0
    sys.exit(f'{app} has no section {want} - the boxes are: '
             + ', '.join(box(name) for _n, name, _cap, _b in found))


if __name__ == '__main__':
    sys.exit(main())
