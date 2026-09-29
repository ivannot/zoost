#!/usr/bin/env python3
"""Record a submission: python3 tools/submitted.py <app>

Two facts have to be written down after a package goes in front of Google, and both used to be typed:
the `RELEASES.md` row and which screenshots the listing now carries. Neither is a judgement - the row
is printed in the Release body by the workflow that built the archive, and the digest is of files
sitting in `dist/`. What no tool can observe is the click, so that is the only thing this takes on
trust: running it *is* saying «I submitted it».

The row is taken from the published Release rather than composed here. That is the point of it: the
commit and the hash in `RELEASES.md` should be the ones GitHub signed, not ones this machine worked
out again from the same inputs.
"""
import hashlib
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = 'ivannot/zoost'


def _shots():
    """The module that *writes* the handover folder, asked where it put things.

    Both paths below used to be spelled out here, and one of them drifted: the images moved into
    `dist/store/<app>/images/` when the shape was fixed, this file went on globbing the folder above
    it, and the only symptom was a note saying the folder was empty - so the screenshot record kept
    naming the version before last for four releases. A reader that spells a writer's path itself is
    a copy waiting to go stale."""
    sys.path.insert(0, str(ROOT / 'tools'))
    import shots
    return shots


def release_row(app: str, version: str) -> str:
    url = f'https://api.github.com/repos/{REPO}/releases/tags/{app}-v{version}'
    try:
        with urllib.request.urlopen(url) as r:
            body = json.load(r).get('body', '')
    except Exception as e:
        sys.exit(f'cannot read the Release for {app}-v{version}: {e}\n'
                 f'  has `git push --follow-tags` run, and did the workflow finish?')
    for line in body.splitlines():
        if re.match(rf'^\|\s*{app}\s*\|\s*{re.escape(version)}\s*\|', line):
            return line.strip()
    sys.exit(f'the Release body for {app}-v{version} carries no ledger row - read it by hand')


def shots_sources(app: str):
    """The per-shot source digests beside the images - what they are a picture of.

    Read from the stamp `shots.py` writes next to the set rather than recomputed, so this records
    the state the *rendered* files belong to and not the tree as it is at the moment of recording.
    """
    stamp = _shots().stamp_file(app)
    try:
        return json.loads(stamp.read_text(encoding='utf-8'))
    except Exception:                                   # noqa: BLE001 - absent is a fact, not a crash
        return None


def shots_ledger(app: str, version: str) -> str:
    folder = _shots().store_images(app)
    pngs = sorted(folder.glob('*.png'), key=lambda f: int(f.stem))
    if not pngs:
        return f'  {folder.relative_to(ROOT)} is empty - run tools/shots.py if you uploaded new ones'
    h = hashlib.sha256()
    for f in pngs:
        h.update(f.read_bytes())
    digest = h.hexdigest()[:16]
    led = ROOT / 'store' / app / 'screenshots.json'
    was = json.loads(led.read_text(encoding='utf-8')) if led.exists() else {}
    led.write_text(json.dumps({
        '_': was.get('_', 'What is on the Store listing right now. The upload is a manual step and '
                          'nothing here can observe it, so it is recorded by running '
                          '`python3 tools/submitted.py <app>` after submitting.'),
        'version': version, 'digest': digest,
        # What the pictures are *of*, which is the value the verdict is taken from. The byte digest
        # above stays as a record of the exact files uploaded, and is no longer asked whether
        # anything changed: a capture is not bit-exact - the panel does asynchronous work on a time
        # budget - so two renders of one commit differ by a few dozen bytes and the comparison said
        # «upload all five again» over pictures nobody could tell apart. `siteimg.py` had measured
        # exactly that and written it down; this tool, one directory over, was doing the thing that
        # docstring forbids.
        'sources': shots_sources(app),
        # What the pictures *are*, so the next release can say «same pictures» instead of «upload all
        # five again» whenever any file the render reads has moved - which is every release that
        # touches the panel, and which taught the reader to ignore the line.
        'pixels': _shots().pixel_digests(pngs),
        'files': [f.name for f in pngs], 'folder': f'dist/store/{app}/images/',
    }, indent=2) + '\n', encoding='utf-8')
    return f'  screenshots: {len(pngs)} file(s), digest {digest}, recorded for {version}'


def listing_ledger(app: str, version: str) -> str:
    """What each store field said when it was last submitted, so the next release can name the two
    boxes that moved instead of leaving nine to be opened and compared by eye."""
    sys.path.insert(0, str(ROOT / 'tools'))
    import storecopy
    (ROOT / 'store' / app / 'listing.json').write_text(json.dumps({
        '_': 'Each store field as submitted, hashed. `python3 tools/storecopy.py <app> --changed` '
             'compares against it and says which boxes need pasting.',
        'version': version, 'sections': storecopy.digests(app),
    }, indent=2) + '\n', encoding='utf-8')
    return f'  listing: {len(storecopy.digests(app))} field(s) recorded as submitted for {version}'


def main() -> int:
    if len(sys.argv) != 2 or not (ROOT / 'apps' / sys.argv[1]).is_dir():
        sys.exit('usage: python3 tools/submitted.py <crm|analytics>')
    app = sys.argv[1]
    version = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))['version']

    ledger = ROOT / 'RELEASES.md'
    text = ledger.read_text(encoding='utf-8')
    row = release_row(app, version)
    if f'| {app} | {version} |' in text:
        print(f'  RELEASES.md already has {app} {version}')
    else:
        # Appended after the last row, which is where «newest last» puts it - not at the end of the
        # file, where the prose about what the table cannot prove lives.
        rows = [l for l in text.splitlines() if re.match(r'^\|\s*(crm|analytics)\s*\|', l)]
        text = text.replace(rows[-1] + '\n', rows[-1] + '\n' + row + '\n', 1)
        ledger.write_text(text, encoding='utf-8')
        print(f'  RELEASES.md: {row}')
    print(shots_ledger(app, version))
    print(listing_ledger(app, version))
    return 0


if __name__ == '__main__':
    sys.exit(main())
