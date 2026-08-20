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

    python3 tools/auditcheck.py             # everything, needs the network
    python3 tools/auditcheck.py --offline   # skip the live comparison, and say so as a finding
    python3 tools/auditcheck.py --before-tag  # the gate release.sh runs; see deploy_state()
    python3 tools/auditcheck.py --accept    # record today's absolute claims as read

`--offline` and `--before-tag` skip the same section and differ in one thing: whether the skip, and
an unpushed commit, are refusals or notes. Interactively they are refusals, because reporting a fix
as live when nothing has been deployed is the failure that put them there. At tag time they are
structurally true and cannot be acted on, so a gate that refused over them could never pass - and
did not, for the whole hour between it landing and somebody trying to use it.

**Not part of tests/run.sh**, for the same reason `reachcheck.sh` is not: it needs the network and
the live site, and a suite that fails because DNS was slow is a suite people stop believing. Run it
before a tag, next to the suite.
"""
# Runs on Python 3.9, which is still the system interpreter on some macOS releases: `str | None` in
# an annotation is a TypeError at import time there, and this tool is exactly the kind of thing that
# gets run on a machine nobody prepared. The future import makes every annotation a string.
from __future__ import annotations
import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
import time
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
    pending = []                 # differences are re-fetched once; see below
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
            pending.append((rel, url, p, f'{rel}: {url} is not the file in the repository '
                                         f'({len(body)} bytes served, {len(mine)} here)'))
            continue
        if not body:
            # An empty body hashed to e3b0c442… and was reported as a content mismatch, which sends
            # you looking for a stale deploy. It is a fetch that returned nothing — usually a 404 or
            # a request that landed mid-deploy — and saying so is the difference between one retry
            # and half an hour.
            pending.append((rel, url, p,
                            f'{rel}: {url} returned an empty body — not a stale page, no page'))
            continue
        pending.append((rel, url, p, f'{rel}: {url} does not contain what the repository holds '
                                     f'(live {hashlib.sha256(body).hexdigest()[:12]}, '
                                     f'repo {hashlib.sha256(mine).hexdigest()[:12]})'))
    # A deploy does not land everywhere at once, and this ran twice within a minute of a push and
    # reported one file each time - crm-preview.webp, then index.html - each of which matched a
    # moment later. Reporting propagation as a stale deploy is how a check starts being ignored, and
    # ignoring a stale deploy is what this check exists to prevent, so the answer is neither: fetch
    # the ones that differed **once more** and report only what still differs. A file that is
    # genuinely wrong is still wrong ten seconds later, so nothing real is hidden by the wait.
    if pending:
        time.sleep(10)
        for rel, url, p, message in pending:
            out = subprocess.run(['curl', '-sS', '--max-time', '20', '-A',
                                  'zoost auditcheck (+https://zoost.it)', url],
                                 capture_output=True, timeout=30)
            if out.returncode == 0 and out.stdout == p.read_bytes():
                notes.append(f'{rel}: differed on the first fetch and matched on the second - the '
                             f'deploy was still propagating, not a stale file')
            else:
                findings.append(message + ' - and again ten seconds later')
    notes.append(f'{len(published)} published files compared against the live site')


def canonicals_answer_without_redirecting(findings: list, notes: list) -> None:
    """A canonical URL has to be the one that answers 200, and only the network can say which it is.

    Cloudflare serves `crm.html` at `/crm` and 307s the `.html` form to it. Every page declared
    `https://zoost.it/crm.html`, so the canonical pointed at a redirect while `/crm` — the URL that
    actually answers — announced itself as an alternative of it. Google indexed neither: Search
    Console reported "alternative page with proper canonical tag" and the product pages were
    invisible. It went unseen for as long as the pages existed because every check derived the URL
    from the file's path, which is a fact about the repository, and the redirect is a fact about the
    platform. Nothing that reads only these files can catch the next one either — hence a check that
    asks the site.
    """
    pages = sorted(SITE.glob('*.html')) + sorted((SITE / 'it').glob('*.html'))
    checked = 0
    for p in pages:
        rel = p.relative_to(SITE).as_posix()
        for kind, url in re.findall(
                r'<link rel="(canonical|alternate)" (?:hreflang="[^"]+" )?href="([^"]+)"',
                p.read_text(encoding='utf-8')):
            if not url.startswith(BASE_URL):
                continue
            out = subprocess.run(['curl', '-sS', '-o', '/dev/null', '--max-time', '20',
                                  '-w', '%{http_code} %{redirect_url}', '-A',
                                  'zoost auditcheck (+https://zoost.it)', url],
                                 capture_output=True, text=True, timeout=30)
            code, _, dest = (out.stdout.strip() + ' ').partition(' ')
            checked += 1
            if code != '200':
                findings.append(f'{rel}: the {kind} URL {url} answers {code}'
                                + (f' and redirects to {dest.strip()}' if dest.strip() else '')
                                + ' — a search engine can index neither it nor its target')
    notes.append(f'{checked} canonical and alternate URLs answer 200 without redirecting')


# What each endpoint must carry, per route, because they answer different questions: /api/versions
# feeds every page's footer badge, /api/ahead feeds /emergency alone. One list applied to both
# reported `siteUpdated` missing from a payload that never had a reason to carry it - the check
# calling a correct endpoint broken, which is the failure mode that teaches people to ignore it.
#
# A route with no entry here is a **finding**, never a skip. The routes themselves are derived from
# the Worker, so a new one arrives on its own; without this, it would arrive with no contract and
# nothing would say so.
ENDPOINT_FIELDS = {
    '/api/versions': ('crm', 'analytics', 'siteUpdated'),
    '/api/ahead': ('crm', 'analytics', 'cws'),
}


def worker_routes_answer(findings: list, notes: list) -> None:
    """Every route the Worker owns, asked of the live site and checked for the right *shape*.

    `live_matches_repo` compares files, and a file is not what the Worker serves - so when
    `assets.not_found_handling` was switched on and `/api/versions` stopped reaching the script at
    all, every check here passed while the footer badge and the guides' version stamp were dead on
    every page. The deploy succeeded, every page rendered, and the one thing that broke is the one
    designed to fail quietly: a badge that cannot read its endpoint simply does not appear.

    The routes are read out of `_worker.js` and `wrangler.jsonc` rather than listed here, because a
    list is the thing that failed - the preview was verified against the routes I happened to think
    of. What each kind must answer is stated per kind: the endpoint returns JSON with the fields the
    page consumes, a redirect source redirects, and a `.txt` carries its charset.
    """
    worker = (SITE / '_worker.js').read_text(encoding='utf-8')
    cfg = (SITE / 'wrangler.jsonc').read_text(encoding='utf-8')

    def head(url):
        # `|`, not a space: content_type is `text/plain; charset=utf-8` and splitting on whitespace
        # put the charset into the redirect field - which made this check report the very defect it
        # exists to catch, on a header that was correct. A separator has to be one the values cannot
        # contain, and that is the same lesson as the \x1e record separator two tools over.
        out = subprocess.run(['curl', '-sS', '-o', '/dev/null', '--max-time', '20', '-w',
                              '%{http_code}|%{content_type}|%{redirect_url}', '-A',
                              'zoost auditcheck (+https://zoost.it)', url],
                             capture_output=True, text=True, timeout=30).stdout.split('|')
        return (out + ['', '', ''])[:3]

    def post(url, origin):
        return subprocess.run(['curl', '-sS', '-o', '/dev/null', '--max-time', '20', '-w',
                               '%{http_code}', '-X', 'POST', '-H', 'content-type: application/json',
                               '-H', f'origin: {origin}', '--data', '{}', '-A',
                               'zoost auditcheck (+https://zoost.it)', url],
                              capture_output=True, text=True, timeout=30).stdout.strip()

    def post_only(path):
        """Whether the route refuses everything but POST, read out of its own handler.

        `/api/report` answers **405** to a GET, which is correct and which the 200-or-finding rule
        above called «the Worker is not being reached» - the check calling a working endpoint broken,
        the exact failure this function's docstring already warns about, one route later. The
        contract is not listed here for the same reason the routes are not: it is derived, so a
        POST-only route added tomorrow arrives with its contract attached.
        """
        m = re.search(r"url\.pathname === '%s'\) return (\w+)\(" % re.escape(path), worker)
        if not m:
            return False
        h = re.search(r'(?:async )?function %s\(' % m.group(1), worker)
        return bool(h) and "request.method !== 'POST'" in worker[h.end():h.end() + 400]

    checked = 0
    for path in re.findall(r"url\.pathname === '([^']+)'", worker):
        if post_only(path):
            checked += 1
            code, _, _ = head(BASE_URL + path)
            if code == '404':
                findings.append(f'{path}: answers 404 to a GET - the Worker is not being reached '
                                f'(check run_worker_first against not_found_handling)')
            elif code != '405':
                findings.append(f'{path}: answers {code} to a GET, and its handler refuses '
                                f'everything but POST - so something in front of it is answering')
            else:
                # A POST carrying a foreign origin is refused by the handler's first gate, before
                # the body is read, before the limiter and before anything is written - so this is
                # a live probe of the whole route that cannot open an issue or spend a quota.
                code2 = post(BASE_URL + path, 'https://example.invalid')
                if code2 != '403':
                    findings.append(f'{path}: a POST from another origin answers {code2}, not 403 - '
                                    f'the gate that stops any page on the web posting here is open')
            continue
        code, ctype, _ = head(BASE_URL + path)
        checked += 1
        if code != '200':
            findings.append(f'{path}: answers {code}, not 200 - the Worker is not being reached '
                            f'(check run_worker_first against not_found_handling)')
            continue
        body = subprocess.run(['curl', '-sS', '--max-time', '20', BASE_URL + path],
                              capture_output=True, text=True, timeout=30).stdout
        try:
            d = json.loads(body)
        except Exception:                                     # noqa: BLE001 - reported, not raised
            findings.append(f'{path}: answers 200 but the body is not JSON '
                            f'(starts {body[:40]!r}) - a cached error can outlive its fix, so bump '
                            f'CACHE_KEY as well as fixing the route')
            continue
        # the fields the page actually reads; a payload missing one renders something that says nothing
        needs = ENDPOINT_FIELDS.get(path)
        if needs is None:
            findings.append(f'{path}: a Worker route with no declared shape - name the fields the '
                            f'page reads from it in ENDPOINT_FIELDS, or nothing here checks it')
            continue
        for key in needs:
            if key not in d:
                findings.append(f'{path}: the payload has no "{key}", which the page reading it needs')

    for src in re.findall(r"'(/[^']*)':", re.search(r'const MOVED = \{(.*?)\}', worker, re.S).group(1)):
        code, _, dest = head(BASE_URL + src)
        checked += 1
        if not code.startswith('3'):
            findings.append(f'{src}: answers {code} instead of redirecting - a published extension '
                            f'has this URL compiled into it')
        elif dest:
            code2, _, _ = head(dest.strip())
            if code2 != '200':
                findings.append(f'{src}: redirects to {dest.strip()}, which answers {code2}')

    for path in re.findall(r'"(/[^"*]+\.txt)"', cfg):
        code, ctype, _ = head(BASE_URL + path)
        checked += 1
        if code != '200':
            findings.append(f'{path}: answers {code}')
        elif 'charset' not in ctype:
            findings.append(f'{path}: served as {ctype.strip()} with no charset - a .txt cannot '
                            f'declare its own, so every dash arrives mangled')

    notes.append(f'{checked} Worker-owned routes answered in the expected shape')


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
# A dashboard field, fenced or not. The numbering is the file's own, the same one `storecopy.SECTION`
# reads - this matches the heading and stops at the next one, so a section with no fence (the data
# disclosures: a table and a blockquote) is still outward prose. Anything not under a numbered
# heading is a note to ourselves.
NUMBERED = re.compile(r'^## \d+\.[^\n]*\n(?P<body>.*?)(?=^## |\Z)', re.S | re.M)


def sentences(path: Path) -> list:
    """The prose of a page, without its chrome.

    This used to read the whole file, so the `<title>` and every navigation label were glued onto the
    first sentence - and any change to the chrome rewrote that sentence on all eighteen pages and put
    them back on the ledger to be read again. Twice in one day: adding a nav item, then adding a skip
    link. Nothing had been claimed, but a diff of thirty rows that says nothing is how a ledger stops
    being read, which is the failure mode this file exists to avoid. The header and footer are
    identical everywhere and `sitecheck` already compares them; what belongs here is what each page
    actually asserts.

    A store listing is the same problem with a sharper boundary. The file is a working document -
    a paragraph about which checks read it, a "Notes before submitting" list, sometimes a note to
    whoever submits next - wrapped around the fields that are actually pasted into the dashboard.
    Read whole, a sentence we wrote to ourselves lands on a ledger of public claims: a note added
    today had to be reworded to avoid the word "every", which is the tail wagging the dog.

    **The boundary is the numbered section, not the fence.** Nine of them are a fenced block and
    `storecopy` copies those to the clipboard one at a time; `## 10. Data disclosures` is a table and
    a blockquote, because it is a set of dashboard checkboxes and their justification rather than a
    paste field - and that blockquote says "Nothing is sent to the developer" and "the rows inside
    tables are never sent", which is exactly the kind of claim this ledger exists to hold. Reading
    fenced blocks alone would have dropped it silently. `sitecheck` once made the mirror-image
    mistake on these same files - it *stripped* the fences and passed on prose it had never read -
    so the rule is: everything under a `## <n>.` heading is outward, everything else in the file is
    ours. The fenced body is preferred where there is one, which drops the heading and the backticks
    from the first sentence of each section; `storecopy.SECTION` is imported rather than restated,
    because two copies of the pattern that decides what is published would drift.

    A listing yielding no numbered section at all is a finding rather than an empty list - see
    `absolutes()`.
    """
    s = path.read_text(encoding='utf-8')
    if path.name == 'store-listing.md':
        import storecopy                     # tools/ is on sys.path: this file lives in it
        out = []
        for m in NUMBERED.finditer(s):
            body = m.group(0)
            fenced = storecopy.SECTION.search(body)
            out.append(fenced.group('body') if fenced else m.group('body'))
        # A blockquote is markdown for "this is the justification under the checkboxes", and its
        # `> ` is markup rather than prose. Left in, it lands *inside* the sentence - the ledger
        # held «the rows > inside tables are never sent» - so it became part of the key of a real
        # claim, and a reader met a promise with a stray character through the middle of it.
        s = re.sub(r'^[ \t]*>[ \t]?', '', '\n\n'.join(out), flags=re.M)
    elif path.suffix == '.html':
        s = re.sub(r'<(script|style)[\s\S]*?</\1>', ' ', s)
        # A stamp is a date or a version written by tools/stamp.py, and it moves whenever the page
        # does. Left in, it becomes part of the key of whatever sentence it sits in, so an unchanged
        # claim re-enters this ledger as new every time the file is touched - noise, in the one check
        # whose whole value is that its findings are rare enough to be read.
        s = re.sub(r'<(\w+)[^>]*\bdata-stamp="[^"]*"[^>]*>.*?</\1>', ' ', s, flags=re.S)
        s = re.sub(r'<(header|footer)\b[\s\S]*?</\1>', ' ', s)
        m = re.search(r'<main\b[^>]*>([\s\S]*?)</main>', s)
        if m:
            s = m.group(1)
        s = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    return [' '.join(x.split()) for x in re.split(r'(?<=[.!?])\s+', ' '.join(s.split()))]


def absolutes() -> tuple:
    """Every absolute in outward prose, keyed by the sentence, plus the files that went quiet.

    Narrowing a checker's input is the moment it can start reporting nothing and calling it clean:
    if a heading is reformatted or a fence loses a backtick, `SECTION` matches nothing, the listing
    contributes no sentences, and a differential ledger says «0 new» - the correct answer to the
    wrong question. Disappearing claims are invisible here by construction, because only additions
    are reported. So an empty parse is a finding of its own.
    """
    out, quiet = {}, []
    for pattern in OUTWARD:
        for p in sorted(ROOT.glob(pattern)):
            lines = sentences(p)
            # `not lines` is the wrong test and looked like the right one: splitting an empty string
            # yields [''], a list of one, which is truthy - so the guard would have stayed silent in
            # precisely the case it exists for. Found by the test, not by reading.
            if p.name == 'store-listing.md' and not any(l.strip() for l in lines):
                quiet.append(f'{p.relative_to(ROOT)}: no fenced section parsed out of it, so none of '
                             f'the copy that gets pasted into the dashboard was read - a heading or a '
                             f'fence has moved away from what tools/storecopy.py matches')
            for line in lines:
                if len(line) > 8 and ABSOLUTE.search(line):
                    out[hashlib.sha256(line.encode()).hexdigest()[:16]] = f'{p.relative_to(ROOT)}: {line}'
    return out, quiet


def absolutes_reviewed(findings: list, notes: list, accept: bool) -> None:
    """An absolute invites a literal check, and a reader in that mode treats every one as a target.
    "Zoost never writes to Zoho" fell to a single POST whose URL contains CREATE — the claim was
    about which endpoints we call, and the sentence said something the browser does not enforce.

    Printing all of them every run would be 300 lines nobody reads, so this is differential: it shows
    what is **new since the last time they were accepted**, and fails until someone accepts. That is
    the whole mechanism — a new absolute gets read once, deliberately, before it ships.
    """
    now, quiet = absolutes()
    findings.extend(quiet)      # before the branch: a file that was not read must not be accepted either
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


def deploy_state(findings: list, notes: list, offline: bool, before_tag: bool = False) -> None:
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

    # `--before-tag` is the gate `tools/release.sh` runs, and it exists because the two findings
    # below are *structurally* true at that moment: the version bump has been committed and not yet
    # pushed (the routine pushes the commit and the tag together, afterwards), and the site cannot
    # already serve a release that does not exist. Reported as findings there, the gate could never
    # pass - which is exactly what it did: the check landed in release.sh an hour after the last tag
    # and refused every run, unfixably, until somebody tried to cut a release. They are still said
    # out loud, as notes, because the thing they guard against - claiming "fixed" about a page nobody
    # has deployed - is real. What changes is only whether they can be acted on.
    say = notes.append if before_tag else findings.append

    ahead = git('rev-list', '--count', '@{upstream}..HEAD')
    if ahead is None:
        notes.append('deploy state unknown: no upstream, or git could not be asked')
    elif ahead != '0':
        say(f'{ahead} commit(s) are not pushed. The site is built from what GitHub has, '
            f'so nothing here can be true of zoost.it until they are — say "in the '
            f'repository", not "fixed", until this is 0.')
    dirty = git('status', '--porcelain')
    if dirty:
        # Not softened by --before-tag: release.sh refuses a dirty tree before it gets here, so a
        # dirty tree at this point is a real finding in any mode.
        findings.append(f'{len(dirty.splitlines())} file(s) changed and not committed — the '
                        f'comparison below is against a tree nobody else can see')
    if offline:
        say('the live site was not looked at. This run says what the repository holds, and nothing '
            'whatever about what zoost.it serves.')


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
    ap.add_argument('--before-tag', action='store_true',
                    help='the gate release.sh runs: everything the repository can be held to, with '
                         'what cannot yet be true said as a note rather than refused')
    ap.add_argument('--accept', action='store_true', help='record today’s absolute claims as read')
    args = ap.parse_args()
    offline = args.offline or args.before_tag

    findings, notes = [], []
    deploy_state(findings, notes, offline, args.before_tag)
    if not offline:
        live_matches_repo(findings, notes)
        canonicals_answer_without_redirecting(findings, notes)
        worker_routes_answer(findings, notes)
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
    # The clean line has to say what was actually looked at. `--before-tag` can now end in «0
    # findings», which `--offline` never could, and the sentence it inherited opened by asserting
    # that what is served matches the repository - about a run that did not fetch a single page.
    # A summary is a claim like any other on the way out of this file.
    print(f'{len(findings)} finding(s). A release should not be tagged over these.'
          if findings else
          ('0 findings. The store copy matches the manifests and every absolute claim has been read. '
           'The live site was not looked at: run this without a flag once the push has landed.'
           if offline else
           '0 findings. What is served is what is in the repository, the store copy matches the '
           'manifests, and every absolute claim has been read.'))
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
