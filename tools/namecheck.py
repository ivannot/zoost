#!/usr/bin/env python3
"""
namecheck.py — nothing an app ships may name, link to, or identify itself as the other product.

Written after the fifth naming defect reached the user rather than a check: an Analytics window
titled "Zoost — Zoho CRM", an Analytics Help link opening the CRM guide, two About dialogs offering
different links, a release titled "Zoost for crm", and a generic /docs URL owned by one product.
None of them were hard to see. All of them were invisible to the checks that existed, for two
reasons worth stating because they are the actual lesson:

  1. `twincheck.py` compares exactly two files per app — sidepanel.html and sidepanel.js — out of
     the twelve each one ships. graphview.html and options.html were never looked at by anything.
     The list of files was written by hand, which is the "checklist wearing a script's clothes"
     failure that CLAUDE.md warns about, sitting inside the tool meant to prevent it.

  2. Both existing checks compare *structure*: ids, classes, CSS declarations, handlers. A product
     name is none of those. It is a string, and no check read strings.

So this one derives its file list by globbing — a file added tomorrow is covered without anyone
remembering — and it reads the strings.

    python3 tools/namecheck.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPS = ('crm', 'analytics')

# How each product refers to itself and to nothing else.
MARKS = {
    'crm': {
        'platform': 'Zoho CRM',
        'pages': ('/crm.html', '/docs-crm.html'),
        'shortname': 'Zoost CRM',
    },
    'analytics': {
        'platform': 'Zoho Analytics',
        'pages': ('/analytics.html', '/docs-analytics.html'),
        'shortname': 'Zoost Analytics',
    },
}
OTHER = {'crm': 'analytics', 'analytics': 'crm'}

# Places a product may legitimately name the other one, each with its reason. As everywhere else in
# this repository the list is of what is *allowed*, never of what to check: forgetting to declare
# something makes it reported, which is the only direction that fails safe.
ALLOWED = {
    # file suffix -> list of (fragment, reason)
    'apps/analytics/sidepanel.js': [
        ('the CRM', 'comments comparing the two panels are how the twin rule is documented in code'),
    ],
    'apps/crm/sidepanel.js': [
        ('Analytics', 'comments comparing the two panels'),
    ],
    'apps/analytics/content-bridge.js': [
        ('CRM', 'comments citing the CRM bridge, which is where the CSRF lesson came from'),
    ],
    'apps/crm/content-bridge.js': [
        ('Analytics', 'ditto, the other way round'),
    ],
    'apps/analytics/options.js': [
        ('CRM', 'comments stating that this is shared chrome and must match the other panel'),
    ],
    'apps/crm/options.js': [
        ('Analytics', 'ditto'),
    ],
}


def strip_comments(text: str, is_js: bool) -> str:
    """Comments are where the twin rule is *documented*; they are not user-visible.

    Cutting them is what makes the allow-list above small enough to be honest. What remains is
    markup, strings and template literals — the things a user can actually read.
    """
    if is_js:
        text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
        text = re.sub(r'^\s*//.*$', ' ', text, flags=re.M)
        text = re.sub(r'(?<![:"\'`])//[^\n"\'`]*$', ' ', text, flags=re.M)
    else:
        text = re.sub(r'<!--.*?-->', ' ', text, flags=re.S)
    return text


def check_app(app: str, findings: list) -> None:
    other = OTHER[app]
    mine, theirs = MARKS[app], MARKS[other]
    manifest = json.loads((ROOT / f'apps/{app}/manifest.json').read_text(encoding='utf-8'))

    # The manifest is the authority on the product's name, so identity is compared against it
    # rather than against a copy of it kept here — a second copy is a second thing to go stale.
    for field, value in (('name', manifest['name']),
                         ('short_name', manifest['short_name']),
                         ('description', manifest['description']),
                         ('action.default_title', manifest['action']['default_title'])):
        if theirs['platform'] in value:
            findings.append(f'apps/{app}/manifest.json: {field} names {theirs["platform"]}')
        if field != 'short_name' and mine['platform'] not in value:
            findings.append(f'apps/{app}/manifest.json: {field} does not name {mine["platform"]}')

    for path in sorted((ROOT / f'apps/{app}').rglob('*')):
        if path.suffix not in ('.html', '.js') or not path.is_file():
            continue
        rel = str(path.relative_to(ROOT))
        raw = path.read_text(encoding='utf-8')
        body = strip_comments(raw, path.suffix == '.js')
        allowed = [frag for frag, _ in ALLOWED.get(rel, [])]

        # Every page states which product's window it is. This is the one that shipped broken: the
        # Analytics diagram window carried the CRM's title from the day the graph was ported.
        if path.suffix == '.html':
            m = re.search(r'<title>(.*?)</title>', raw, re.S)
            if not m:
                findings.append(f'{rel}: no <title> — every page must say which product it belongs to')
            elif mine['platform'] not in m.group(1):
                findings.append(f'{rel}: <title> is {m.group(1)!r}, which does not name {mine["platform"]}')

        # Naming or linking to the other product.
        for hit in re.finditer(re.escape(theirs['platform']), body):
            ctx = ' '.join(body[max(0, hit.start() - 40):hit.end() + 25].split())
            if any(a in ctx for a in allowed):
                continue
            findings.append(f'{rel}: names {theirs["platform"]} — …{ctx}…')
        for page in theirs['pages']:
            if page in body:
                findings.append(f'{rel}: links to {page}, which belongs to {theirs["platform"]}')


def check_release_workflow(findings: list) -> None:
    """The release title is a public surface too, and it is the one nothing was watching.

    GitHub published "Zoost for crm 1.9.0" because the workflow interpolated a directory name into
    a title. Nothing compared it to anything, because it is neither panel nor page.
    """
    wf = ROOT / '.github/workflows/release.yml'
    if not wf.exists():
        return
    s = wf.read_text(encoding='utf-8')
    m = re.search(r'^\s*name:\s*(Zoost[^\n]*)$', s, re.M)
    if not m:
        findings.append('.github/workflows/release.yml: no release title found')
        return
    title = m.group(1)
    if 'outputs.app' in title:
        findings.append('.github/workflows/release.yml: the release title interpolates the directory '
                        f'name rather than the product name — {title.strip()!r}')


def main() -> int:
    findings = []
    for app in APPS:
        check_app(app, findings)
    check_release_workflow(findings)

    files = sum(1 for app in APPS for p in (ROOT / f'apps/{app}').rglob('*')
                if p.suffix in ('.html', '.js') and p.is_file())
    print(f'namecheck: {files} shipped files across {len(APPS)} apps')
    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). Each is a surface naming the wrong product, or failing to name its own.'
          if findings else
          '0 findings. Every shipped file names its own product and nothing else.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
