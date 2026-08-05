#!/usr/bin/env python3
"""
auditcheck.py — the outside view of a release, mechanised.

Every outside review of this project has found something, and the useful ones divide cleanly in two.
Some findings are a **property of a value**: a host in a manifest that no page names, a store field
over its limit, a page on the edge that is not the page in the repository. Those do not need a
reader; they need a comparison, and every one of them has become a check. The rest are judgement —
whether a sentence misleads, whether a claim is stronger than what the code does — and no tool
decides those. This runs the first kind, and *presents* the second kind rather than pretending to
rule on it.

It exists because of one review in particular, which opened by stating that the homepage and
llms.txt served by zoost.it were still an earlier generation, "not a part: all of it". A `shasum` of
five pages against the repository refuted it in thirty seconds. That comparison is now section 1, so
the next time the answer takes no argument at all.

    python3 tools/auditcheck.py            # everything, needs the network
    python3 tools/auditcheck.py --offline  # skip the live comparison
    python3 tools/auditcheck.py --accept   # record today's absolute claims as read

**Not part of tests/run.sh**, for the same reason `reachcheck.sh` is not: it needs the network and
the live site, and a suite that fails because DNS was slow is a suite people stop believing. Run it
before a tag, next to the suite.
"""
import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
BASE_URL = 'https://zoost.it'
BASELINE = ROOT / 'tools' / 'absolutes.txt'

# Cloudflare serves /foo.html at /foo, so the published path is not always the file name.
def published_path(name: str) -> str:
    return '/' if name == 'index.html' else ('/' + name[:-5] if name.endswith('.html') else '/' + name)


# ---------------------------------------------------------------------------------------------------
# 1. What is served is what is in the repository
# ---------------------------------------------------------------------------------------------------

def live_matches_repo(findings: list, notes: list) -> None:
    """Byte for byte. A page on the edge that is older than the repository is invisible from here —
    nothing in the deploy reports it, and the site looks fine because it *is* a real page, just not
    the current one. This is the check that turns a long argument into one line.
    """
    published = sorted([p for p in SITE.glob('*.html')] + [p for p in SITE.glob('*.txt')])
    for p in published:
        if p.name == 'robots.txt':
            pass  # published like any other, no exception — listed for completeness
        url = BASE_URL + published_path(p.name)
        try:
            out = subprocess.run(['curl', '-sS', '--max-time', '20', '-A',
                                  'zoost auditcheck (+https://zoost.it)', url],
                                 capture_output=True, timeout=30)
        except Exception as e:                                   # noqa: BLE001 — reported, not raised
            findings.append(f'{p.name}: could not be fetched from {url} ({e})')
            continue
        if out.returncode != 0:
            findings.append(f'{p.name}: curl failed for {url} — {out.stderr.decode()[:120].strip()}')
            continue
        live = hashlib.sha256(out.stdout).hexdigest()
        repo = hashlib.sha256(p.read_bytes()).hexdigest()
        if live != repo:
            findings.append(f'{p.name}: {url} is not what the repository holds '
                            f'(live {live[:12]}, repo {repo[:12]})')
    notes.append(f'{len(published)} published files compared against the live site')


# ---------------------------------------------------------------------------------------------------
# 2. The store copy and the manifest are one thing said twice
# ---------------------------------------------------------------------------------------------------

def section(md: str, number: int) -> str | None:
    """The fenced block under `## <n>.` — the text meant to be pasted into the dashboard."""
    m = re.search(r'^## %d\.[^\n]*\n+```\n(.*?)\n```' % number, md, re.S | re.M)
    return m.group(1).strip() if m else None


def store_matches_manifest(findings: list, notes: list) -> None:
    """The manifest is the authority and the listing is a copy of it, so the two are checked against
    each other rather than each against a memory. `description` is the most-read sentence the project
    has — Chrome shows it on the extensions page *and* in search results — and it lives in two files.
    """
    checked = 0
    for mf in sorted((ROOT / 'apps').glob('*/manifest.json')):
        app = mf.parent.name
        listing = ROOT / 'store' / app / 'store-listing.md'
        if not listing.exists():
            findings.append(f'store/{app}/store-listing.md: missing, so nothing describes this app on the Store')
            continue
        manifest = json.loads(mf.read_text(encoding='utf-8'))
        md = listing.read_text(encoding='utf-8')
        for number, field, value in ((1, 'name', manifest['name']),
                                     (2, 'description', manifest['description'])):
            got = section(md, number)
            if got is None:
                findings.append(f'store/{app}/store-listing.md: §{number} has no pasteable block')
            elif got != value:
                findings.append(f'store/{app}: §{number} and manifest `{field}` differ\n'
                                f'      manifest: {value}\n'
                                f'      listing : {got}')
            checked += 1
    notes.append(f'{checked} store fields compared against their manifest')


# ---------------------------------------------------------------------------------------------------
# 3. Absolute claims, presented — never judged
# ---------------------------------------------------------------------------------------------------

ABSOLUTE = re.compile(r'\b(never|always|cannot|nothing|no one|every|only|all of)\b', re.I)
OUTWARD = ['site/*.html', 'site/*.txt', 'README.md', 'store/*/store-listing.md']


def sentences(path: Path) -> list:
    s = path.read_text(encoding='utf-8')
    if path.suffix == '.html':
        s = re.sub(r'<(script|style)[\s\S]*?</\1>', ' ', s)
        s = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    return [' '.join(x.split()) for x in re.split(r'(?<=[.!?])\s+', ' '.join(s.split()))]


def absolutes() -> dict:
    out = {}
    for pattern in OUTWARD:
        for p in sorted(ROOT.glob(pattern)):
            for line in sentences(p):
                if len(line) > 8 and ABSOLUTE.search(line):
                    out[hashlib.sha256(line.encode()).hexdigest()[:16]] = f'{p.relative_to(ROOT)}: {line}'
    return out


def absolutes_reviewed(findings: list, notes: list, accept: bool) -> None:
    """An absolute invites a literal check, and a reader in that mode treats every one as a target.
    "Zoost never writes to Zoho" fell to a single POST whose URL contains CREATE — the claim was
    about which endpoints we call, and the sentence said something the browser does not enforce.

    Printing all of them every run would be 300 lines nobody reads, so this is differential: it shows
    what is **new since the last time they were accepted**, and fails until someone accepts. That is
    the whole mechanism — a new absolute gets read once, deliberately, before it ships.
    """
    now = absolutes()
    if accept:
        BASELINE.write_text('\n'.join(f'{k}  {v}' for k, v in sorted(now.items(), key=lambda kv: kv[1])) + '\n',
                            encoding='utf-8')
        notes.append(f'{len(now)} absolute claims recorded as read in {BASELINE.relative_to(ROOT)}')
        return
    if not BASELINE.exists():
        findings.append(f'{BASELINE.relative_to(ROOT)}: no baseline — run with --accept once, after '
                        f'reading what it records')
        return
    was = {line.split('  ', 1)[0] for line in BASELINE.read_text(encoding='utf-8').splitlines() if line.strip()}
    added = [now[k] for k in now if k not in was]
    if added:
        findings.append(f'{len(added)} absolute claim(s) not yet read. Read each, change what overstates, '
                        f'then run --accept:')
        findings.extend('      ' + a for a in sorted(added))
    notes.append(f'{len(now)} absolute claims in outward prose, {len(added)} new')


# ---------------------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--offline', action='store_true', help='skip the comparison against the live site')
    ap.add_argument('--accept', action='store_true', help='record today’s absolute claims as read')
    args = ap.parse_args()

    findings, notes = [], []
    if not args.offline:
        live_matches_repo(findings, notes)
    else:
        notes.append('live comparison skipped (--offline)')
    store_matches_manifest(findings, notes)
    absolutes_reviewed(findings, notes, args.accept)

    print('auditcheck:')
    for n in notes:
        print('  ' + n)
    if findings:
        print()
        for f in findings:
            print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). A release should not be tagged over these.'
          if findings else
          '0 findings. What is served is what is in the repository, the store copy matches the '
          'manifests, and every absolute claim has been read.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
