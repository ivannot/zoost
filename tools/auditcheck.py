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
def published_path(rel: str) -> str:
    """Repository path under site/ → the URL it is served at. `crm.html` is served at `/crm`, and
    `it/crm.html` at `/it/crm` — the extension is dropped at every level, not only the top one."""
    if rel == 'index.html':
        return '/'
    if rel.endswith('/index.html'):
        return '/' + rel[:-len('index.html')]
    return '/' + (rel[:-5] if rel.endswith('.html') else rel)


# ---------------------------------------------------------------------------------------------------
# 1. What is served is what is in the repository
# ---------------------------------------------------------------------------------------------------

def live_matches_repo(findings: list, notes: list) -> None:
    """Byte for byte. A page on the edge that is older than the repository is invisible from here —
    nothing in the deploy reports it, and the site looks fine because it *is* a real page, just not
    the current one. This is the check that turns a long argument into one line.
    """
    # rglob, not glob: site/it/ is published prose like any other, and a check that stops at the
    # top level would compare six pages and silently ignore six more. The path is derived from the
    # file's position, so a third language costs nothing here.
    published = sorted([p for p in SITE.rglob('*.html')] + [p for p in SITE.rglob('*.txt')])
    for p in published:
        rel = p.relative_to(SITE).as_posix()
        # the label is the path, not the basename: with a translation directory there are two
        # `how-to.html`, and a finding that names neither directory names nothing.
        url = BASE_URL + published_path(rel)
        try:
            out = subprocess.run(['curl', '-sS', '--max-time', '20', '-A',
                                  'zoost auditcheck (+https://zoost.it)', url],
                                 capture_output=True, timeout=30)
        except Exception as e:                                   # noqa: BLE001 — reported, not raised
            findings.append(f'{rel}: could not be fetched from {url} ({e})')
            continue
        if out.returncode != 0:
            findings.append(f'{rel}: curl failed for {url} — {out.stderr.decode()[:120].strip()}')
            continue
        body, mine = out.stdout, p.read_bytes()
        if body == mine:
            continue
        # The platform is allowed to *add*, and does: Cloudflare prepends a managed block to
        # robots.txt. What must never happen is our own bytes being altered or missing. Reporting the
        # inequality would make this file cry wolf on every run, which is how a check stops being read.
        if mine in body:
            notes.append(f'{rel}: served with {len(body) - len(mine)} bytes added by the platform, '
                         f'ours intact')
            continue
        if not body:
            # An empty body hashed to e3b0c442… and was reported as a content mismatch, which sends
            # you looking for a stale deploy. It is a fetch that returned nothing — usually a 404 or
            # a request that landed mid-deploy — and saying so is the difference between one retry
            # and half an hour.
            findings.append(f'{rel}: {url} returned an empty body — not a stale page, no page')
            continue
        findings.append(f'{rel}: {url} does not contain what the repository holds '
                        f'(live {hashlib.sha256(body).hexdigest()[:12]}, '
                        f'repo {hashlib.sha256(mine).hexdigest()[:12]})')
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

# The Italian words are here for the same reason as the English ones, not as a courtesy: an absolute
# invites a literal check whatever language it is written in, and «non scrive mai su Zoho» is exactly
# the sentence that fell to one POST. A page nobody's ledger reads is a page where an overstatement
# ships unread.
ABSOLUTE = re.compile(r'\b(never|always|cannot|nothing|no one|every|only|all of'
                      r'|mai|sempre|nessun[ao]?|niente|soltanto|soltanto|unic[ao]|ogni|tutt[eio])\b', re.I)
OUTWARD = ['site/*.html', 'site/*.txt', 'site/it/*.html', 'README.md', 'store/*/store-listing.md']


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

def description_repeats_the_name(findings: list, notes: list) -> None:
    """The short description is read directly under the item name, so it must not restate it.

    Both extensions opened theirs with a near-copy of their own name — "Independent workbench for Zoho
    Analytics: …" under "Zoost — workbench for Zoho Analytics" — spending 40 of 132 characters saying
    the line above again. It is visible in a Web Store search result and invisible in the dashboard,
    which is why it survived: nobody reads the two fields together except a stranger searching.

    The criterion is a run of three consecutive words shared with the name. Two is normal and
    necessary — "Zoho Analytics" has to appear — and three is a sentence borrowing the title.
    """
    for mf in sorted((ROOT / 'apps').glob('*/manifest.json')):
        m = json.loads(mf.read_text(encoding='utf-8'))
        name = re.findall(r"[\w']+", m['name'].lower())
        desc = re.findall(r"[\w']+", m['description'].lower())
        runs = {' '.join(name[i:i + 3]) for i in range(len(name) - 2)}
        for i in range(len(desc) - 2):
            run = ' '.join(desc[i:i + 3])
            if run in runs:
                findings.append(f'apps/{mf.parent.name}/manifest.json: the short description repeats '
                                f'the item name — «{run}» — under which it is read')
                break
    notes.append('short descriptions checked against their item name')


def deploy_state(findings: list, notes: list, offline: bool) -> None:
    """Is what the repository says even *capable* of being what the site serves?

    This exists because of a specific failure, not a hypothetical one. Four commits sat unpushed
    while the fix they contained was reported as done — «aligned in both languages», which was true
    of the working tree and false of the page the user was looking at. He found it by opening the
    site, which is the failure: the difference between "the repo says X" and "the site says X" is
    the whole point of this file, and the sentence had quietly slid from the second to the first.

    The mechanism was `--offline`. It skips the live comparison — the one check that would have
    caught it — and reported the skip as a quiet note among the passes, so a run that proved nothing
    about zoost.it still ended in «0 findings». That is now a finding of its own, and the unpushed
    state is reported without needing the network at all: git knows.
    """
    def git(*a):
        try:
            out = subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True, timeout=15)
            return out.stdout.decode().strip() if out.returncode == 0 else None
        except Exception:                                        # noqa: BLE001 — reported, not raised
            return None

    ahead = git('rev-list', '--count', '@{upstream}..HEAD')
    if ahead is None:
        notes.append('deploy state unknown: no upstream, or git could not be asked')
    elif ahead != '0':
        findings.append(f'{ahead} commit(s) are not pushed. The site is built from what GitHub has, '
                        f'so nothing here can be true of zoost.it until they are — say "in the '
                        f'repository", not "fixed", until this is 0.')
    dirty = git('status', '--porcelain')
    if dirty:
        findings.append(f'{len(dirty.splitlines())} file(s) changed and not committed — the '
                        f'comparison below is against a tree nobody else can see')
    if offline:
        findings.append('--offline: the live site was not looked at. This run says what the '
                        'repository holds, and nothing whatever about what zoost.it serves.')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--offline', action='store_true', help='skip the comparison against the live site')
    ap.add_argument('--accept', action='store_true', help='record today’s absolute claims as read')
    args = ap.parse_args()

    findings, notes = [], []
    deploy_state(findings, notes, args.offline)
    if not args.offline:
        live_matches_repo(findings, notes)
    store_matches_manifest(findings, notes)
    description_repeats_the_name(findings, notes)
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
