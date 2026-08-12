#!/usr/bin/env python3
"""Compare the Chrome Web Store dashboard against store/<app>/store-listing.md.

    python3 tools/dashcheck.py crm page.html
    pbpaste | python3 tools/dashcheck.py crm -

**This is the only check that exists on the listing copy, and it needs a human to run it.** Google
publishes no API for those fields - which is why pasting them is a by-hand step in the first place -
so nothing here can ask the item what it says. The one way to find out is to open the dashboard, save
or copy the page, and hand it to this.

It earned its keep on the first run. §4 and §5 had been corrected in the repository on 8 and 3 August
and never pasted, so Google was still serving «a local, read-only mirror» and «Zoost never writes back
to Zoho» - the absolute this project had already walked back everywhere else. `storecopy --changed`
said "nothing to paste", because `submitted.py` records what is *in the repository* at the moment it
runs and takes the click on trust. That is honest about what it can observe and blind to this exact
drift; the two only differ when somebody looks.

Why the DOM and not the JSON the page also carries: `AF_initDataCallback` holds the same fields, and
reading it would be sturdier against a markup change - but it is positional, so a column inserted
anywhere above shifts everything and the parser would read the wrong string while looking perfectly
healthy. The textareas carry `data-payload="<permission>"`, which names what it holds. A named anchor
that disappears is a loud failure; an index that moves is a quiet one.

The fixtures under tests/ are written from store-listing.md rather than saved from the real page. A
saved page carries a session token, an email address and the author's own portal - none of which
belongs in this repository, and the first two are worse than untidy.
"""
import argparse
import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import storecopy  # noqa: E402

# Which store-listing.md section each dashboard field is. The host justification is the one whose
# payload is not a permission name - Google numbers it instead.
FIELD = {'single-purpose': 4, 'sidePanel': 5, 'storage': 6, 'scripting': 7, 'tabs': 8, '1': 9}

TEXTAREA = re.compile(r'<textarea\b(?P<attrs>[^>]*)>(?P<body>.*?)</textarea>', re.S)
PAYLOAD = re.compile(r'data-payload=(?:"([^"]*)"|([^\s>]+))')
# The single-purpose textarea is the one with no payload; there is exactly one, and asserting that is
# how a markup change announces itself rather than being absorbed.
PRIVACY = re.compile(r'<input[^>]*\bvalue="(https?://[^"]*)"[^>]*maxlength="2048"')


def fields(page: str) -> dict:
    """Every dashboard field this can see, keyed as in FIELD."""
    out, bare = {}, []
    for m in TEXTAREA.finditer(page):
        body = html.unescape(m.group('body')).strip()
        p = PAYLOAD.search(m.group('attrs'))
        if p:
            out[p.group(1) or p.group(2)] = body
        elif body:
            bare.append(body)
    if len(bare) == 1:
        out['single-purpose'] = bare[0]
    elif bare:
        out['single-purpose'] = None      # ambiguous: reported, never guessed
    return out


def state(page: str) -> dict:
    """The switches, read from what the control says rather than from its position."""
    out = {'privacy': None, 'collected': [], 'attested': 0, 'remote': None}
    m = PRIVACY.search(page)
    if m:
        out['privacy'] = m.group(1)
    for m in re.finditer(r'<input\b[^>]*type="checkbox"[^>]*>', page):
        tag, label = m.group(0), re.search(r'aria-label="([^"]*)"', m.group(0))
        if ' checked' not in tag and 'checked>' not in tag and 'checked ' not in tag:
            continue
        if re.search(r'\bvalue="\d+"', tag):
            out['collected'].append(html.unescape(label.group(1)) if label else '?')
        else:
            out['attested'] += 1
    for m in re.finditer(r'<input\b[^>]*type="radio"[^>]*>', page):
        if 'checked' in m.group(0):
            v = re.search(r'\bvalue="(true|false)"', m.group(0))
            if v:
                out['remote'] = v.group(1) == 'true'
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('app')
    ap.add_argument('page', help="the saved dashboard page, or - for stdin")
    args = ap.parse_args()

    page = sys.stdin.read() if args.page == '-' else pathlib.Path(args.page).read_text(
        encoding='utf-8', errors='replace')
    mine = {str(n): body for n, _, _, body in storecopy.sections(args.app)}
    seen, findings = fields(page), []

    for key, n in FIELD.items():
        theirs, ours = seen.get(key), mine.get(str(n))
        if ours is None:
            findings.append(f"store/{args.app}/store-listing.md has no §{n}")
        elif key not in seen:
            findings.append(f"§{n}: the page has no field for {key!r} - the markup moved, "
                            f"or this is the wrong item")
        elif theirs is None:
            findings.append(f"§{n}: more than one unlabelled textarea, so which is the single "
                            f"purpose is a guess - not made")
        elif theirs != ours:
            findings.append(f"§{n} {key}: the dashboard differs from the repository. "
                            f"python3 tools/storecopy.py {args.app} {n} --copy")

    s = state(page)
    # The privacy URL is in no store-listing.md section, so there is nothing there to compare it
    # against - the first version of this check looked, found nothing, and passed in silence. The
    # authority is the page the site actually serves: its own canonical link.
    url = None
    page_file = ROOT / 'site' / 'privacy.html'
    if page_file.exists():
        m = re.search(r'<link rel="canonical" href="([^"]+)"',
                      page_file.read_text(encoding='utf-8'))
        url = m.group(1) if m else None
    if s['privacy'] and url and s['privacy'].rstrip('/') != url.rstrip('/'):
        findings.append(f"privacy policy URL: the dashboard says {s['privacy']}, "
                        f"site/privacy.html is served at {url}")
    elif s['privacy'] and not url:
        findings.append("site/privacy.html declares no canonical URL, so the one on the "
                        "dashboard cannot be checked")
    if s['collected']:
        findings.append("the dashboard declares data collection: " + ", ".join(s['collected'])
                        + " - this project collects none, so either the page or the claim is wrong")
    if s['attested'] != 3:
        findings.append(f"{s['attested']} of the 3 data-use attestations are ticked")
    if s['remote']:
        findings.append("the dashboard says the extension uses remote code, which it does not")

    for f in findings:
        print(f"  {f}")
    checked = len([k for k in FIELD if k in seen])
    print(f"{len(findings)} finding(s). {checked} of {len(FIELD)} fields read from the page"
          + (f", privacy URL and {s['attested']} attestation(s)" if s['privacy'] else ""))
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
