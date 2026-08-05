#!/usr/bin/env python3
"""
featurecheck.py — the site must name every control the panels have.

The requirement this enforces, in the user's words: the site may keep a technical register, but it
must *always* contain every reference to what the tools do, and photograph clearly what can be done
with them. The test it is meant to survive is a real one — hand zoost.it to an assistant, ask what
the product does and whether it is trustworthy, and see whether the answer matches the software. A
capability that exists in the panel and is described nowhere makes that answer wrong by omission,
and nothing was checking for it.

Three naming defects and one silent asymmetry had already reached the user before the equivalent
checks existed for the panels and for the site's chrome. This is the same idea one layer out: not
"is the prose good" — no tool can judge that — but "does every button have a mention somewhere".

The list below is of what is deliberately *not* on the site, each with a reason. As everywhere else
in this repository the direction matters: forgetting to declare something makes it reported.

    python3 tools/featurecheck.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PAGES = {
    'crm': ['site/crm.html', 'site/docs-crm.html', 'site/index.html'],
    'analytics': ['site/analytics.html', 'site/docs-analytics.html', 'site/index.html'],
}

# Controls a reader never needs told about. A dialog's Cancel is not a feature; describing it would
# be noise, and noise is what makes a document stop being read.
EXPECTED_ABSENT = {
    'Cancel': 'closing a dialog without acting needs no explanation',
    'Close': 'ditto',
    'Everything': 'a preset inside the export dialog, explained by the dialog itself',
    'Share-safe': 'ditto',
    'Save defaults': 'ditto',
    'Save tabs': 'ditto',
    'Show all': 'ditto',
    'Save': 'ditto',
    'Reset to preset': 'ditto',
}

# Labels written differently in prose than on the button — the same thing, said in a sentence rather
# than quoted. Each maps to what the site actually calls it.
ALIAS = {
    '+ Workspace': 'workspace',
    'Pull all': 'pull all',
    'Name: display': 'name: display',
}


def labels(app: str):
    """Every visible control label in a panel, with the trailing affordance glyphs removed."""
    html = (ROOT / f'apps/{app}/sidepanel.html').read_text(encoding='utf-8')
    out = {}
    for m in re.finditer(r'<button[^>]*>([^<]{1,40})</button>', html):
        raw = ' '.join(m.group(1).split())
        t = raw.strip('↗↻✕⚙♥ ')
        if not t or t.startswith('&#') or len(t) < 3:
            continue          # glyph-only controls carry a title attribute, not a name
        out[raw] = t
    return out


def main() -> int:
    findings = []
    for app, pages in PAGES.items():
        site = ' '.join((ROOT / p).read_text(encoding='utf-8') for p in pages).lower()
        found = labels(app)
        for raw, t in sorted(found.items()):
            if t in EXPECTED_ABSENT:
                continue
            needle = ALIAS.get(t, t).lower()
            if needle not in site:
                findings.append(f'{app}: “{raw}” exists in the panel and is named nowhere on the site')
        print(f'  {app}: {len(found)} controls checked against {len(pages)} pages')

    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). Every control the panel offers must be findable on the site.'
          if findings else
          '0 findings. The site names every control both panels offer.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
