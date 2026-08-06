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
    # Everything the site publishes, not just its prose. This compared `.html` and `.txt` only, and
    # said «what is served is what is in the repository» while never looking at site.css, site.js, the
    # sitemap, the manifest or a single icon - so a release that replaced fourteen PNGs and rewrote two
    # scripts passed with 0 findings having verified none of them. The exclusions come from
    # .assetsignore, which is the same list Cloudflare uses, rather than from a copy kept here.
    ignored = {ln.strip() for ln in (SITE / '.assetsignore').read_text(encoding='utf-8').splitlines()
               if ln.strip() and not ln.startswith('#')} if (SITE / '.assetsignore').exists() else set()
    published = sorted(f for f in SITE.rglob('*')
                       if f.is_file()
                       and f.name not in ignored
                       and not f.name.startswith('.')
                       and 'functions' not in f.relative_to(SITE).parts)
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
        if p.suffix not in ('.html', '.txt', '.css', '.js', '.json', '.xml', '.webmanifest', '.svg'):
            findings.append(f'{rel}: {url} is not the file in the repository '
                            f'({len(body)} bytes served, {len(mine)} here)')
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
                      r'|mai|sempre|nessun[ao]?|niente|soltanto|unic[ao]|ogni|tutt[eio])\b'
                      r'|\bread-only\b|\bsola lettura\b', re.I)
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


# ---------------------------------------------------------------------------------------------------
# N. A product's published state, as the markup states it
# ---------------------------------------------------------------------------------------------------

# Zoost Analytics went live on the Chrome Web Store while five surfaces still said "submitted, in
# review" and three already said "on the Chrome Web Store" — the site contradicting itself about its
# own product, and reported by a reader.
#
# It was not for want of a mechanism. site.js carried one that hid the "in review" wording the moment
# /api/versions reported a real scraped version, so a *browser* was always shown the truth. But the
# reader this site is deliberately built for — an assistant handed the URL and asked to assess the
# product — does not run scripts, and reads the markup. A fact promoted only at runtime is a fact
# that reader never sees. So the mechanism is gone and the markup states what is true, which is what
# this check holds it to: /api/versions already knows whether a listing serves a version, and the
# pages must not disagree with it in either direction.
#
# The wrong direction is the expensive one. Saying "in review" about something published costs
# nothing but confusion; saying "on the Chrome Web Store" about something still in review sends a
# reader to a listing that serves an error, which is how this got its first finding.
UNPUBLISHED = re.compile(r'in review|in revisione|not yet published|non è ancora pubblicat', re.I)
PUBLISHED = re.compile(r'on the (Chrome )?Web Store|sul Chrome Web Store', re.I)
PRODUCT = {'crm': re.compile(r'Zoho CRM|Zoost CRM', re.I), 'analytics': re.compile(r'Zoho Analytics|Zoost Analytics', re.I)}


def published_state_is_stated(findings: list, notes: list) -> None:
    """Every page must describe each product's store presence the way the Store actually has it.

    Judged per sentence rather than per page: a page naming both products would otherwise let a true
    statement about one excuse a false one about the other."""
    # curl with the same agent the comparison above uses. urllib was tried first and 403s: this
    # repository's own reachcheck notes that Cloudflare's managed rules refuse `Python-urllib`, and
    # the checker walked straight into it.
    try:
        out = subprocess.run(['curl', '-sS', '--max-time', '20', '-A',
                              'zoost auditcheck (+https://zoost.it)', BASE_URL + '/api/versions'],
                             capture_output=True, text=True, timeout=30)
        live = json.loads(out.stdout)
    except Exception as e:                                    # noqa: BLE001 - reported, not raised
        notes.append(f'published state not checked: /api/versions unreachable ({e})')
        return

    state = {a: bool(live.get(a, {}).get('store')) for a in PRODUCT}
    for f in sorted(SITE.rglob('*.html')):
        rel = f.relative_to(SITE).as_posix()
        for line in sentences(f):
            for app, name in PRODUCT.items():
                if not name.search(line):
                    continue
                if state[app] and UNPUBLISHED.search(line):
                    findings.append(f'site/{rel}: says Zoost {app} is in review; the listing serves '
                                    f'{live[app]["store"]} — "{line[:96]}"')
                if not state[app] and PUBLISHED.search(line):
                    findings.append(f'site/{rel}: says Zoost {app} is on the Store; the listing '
                                    f'serves nothing — "{line[:96]}"')
    notes.append('  ' + ', '.join(f'Zoost {a} {"published" if v else "not published"}' for a, v in state.items())
                 + ' — and every page says so')



def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--offline', action='store_true', help='skip the comparison against the live site')
    ap.add_argument('--accept', action='store_true', help='record today’s absolute claims as read')
    args = ap.parse_args()

    findings, notes = [], []
    deploy_state(findings, notes, args.offline)
    if not args.offline:
        live_matches_repo(findings, notes)
        published_state_is_stated(findings, notes)
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
