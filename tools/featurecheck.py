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
SITE = ROOT / 'site'

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
    'Restore built-in defaults': 'the reset inside the layout block, same family as Reset to preset',
    # The saved-pattern editor is described as a whole on both guides - what a saved pattern is, where
    # the list lives, that emptying it stays empty. Its own two buttons are the editor explaining
    # itself, and quoting them would make the paragraph longer without making it clearer.
    'Add pattern': 'a control inside the saved-patterns editor, which the guides describe as a whole',
    'Save patterns': 'ditto',
    # The folder picker. Every quick start on the site opens with choosing a folder; it is described
    # as the action it is rather than quoted as a button, because it is the one step nobody misses.
    'Choose folder…': 'the folder picker, described as the first step of every quick start',
}

# Labels written differently in prose than on the button — the same thing, said in a sentence rather
# than quoted. Each maps to what the site actually calls it.
ALIAS = {
    '+ Workspace': 'workspace',
    'Pull all': 'pull all',
    'Name: display': 'name: display',
    # The two ends of the diagram's depth control. Their names are on the buttons for a screen reader;
    # both guides describe the thing itself as «depth», which is what a reader looks for.
    'One hop less': 'depth',
    'One hop more': 'depth',
    # The toggle names the state it will move to, so the guide describes the pair and the panel shows
    # whichever half is currently offered.
    'Emphasis: modules': 'emphasis: ',
    'Emphasis: tables': 'emphasis: ',
}


def surfaces(app: str):
    """Every shipped file of a product that can define a control, with its text.

    This file read `apps/<app>/sidepanel.html` and nothing else. The panel is not the product: the
    settings page and the diagram window are two more documents the guides describe, and a control
    is a control wherever it is written. Measured when this was widened: 78 buttons in the two side
    panels, **161** across the six pages and the scripts that build markup - so more than half of the
    subject was outside the file the check opened, and its «0 findings» said nothing about them.

    Scripts are in, because a control built by `innerHTML` is a control. They are read as text, which
    is the honest limit and is stated here: a button assembled by `createElement` and given its label
    by a variable cannot be seen by any amount of regex, and this check does not claim to.
    """
    out = []
    for name in ('sidepanel.html', 'options.html', 'graphview.html'):
        p = ROOT / f'apps/{app}/{name}'
        if p.exists():
            out.append((f'apps/{app}/{name}', p.read_text(encoding='utf-8')))
    for p in sorted((ROOT / f'apps/{app}').glob('*.js')):
        # A label written in a script is JavaScript source, so `View \u2197` is six characters here
        # and one arrow on screen. Left as it was, the check compared the escape against the site and
        # reported a control that is named there - a finding about the tool wearing the clothes of a
        # finding about the product, which is the worst kind.
        text = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)),
                      p.read_text(encoding='utf-8'))
        out.append((p.relative_to(ROOT).as_posix(), text))
    return out


BUTTON = re.compile(r'<button([^>]*)>(.*?)</button>', re.S)


def _named(attrs: str, inner: str):
    """(raw, name) for one button, or None with the reason it needs no name."""
    if 'display:none' in attrs:
        return None, 'hidden'
    aria = re.search(r'aria-label="([^"]+)"', attrs)
    text = ' '.join(re.sub(r'<[^>]*>', '', inner).split())
    raw = aria.group(1) if aria else text
    t = raw.strip('↗↻✕⚙♥ ')
    if not t or t.startswith('&#') or len(t) < 3:
        return None, 'a bare glyph with no name of its own: nothing to look up'
    if '${' in t:
        return None, 'named at run time, from data - no fixed name to look up'
    return raw, t


def labels(app: str):
    """Every control's *name* in a product — what it is called, not what it draws.

    Reading the visible text alone was enough while every control was a word. Then three of them
    became marks, and the check went quiet on `Pull all`, `Pull` and `Schema` — coverage shrinking
    silently, which is the failure mode this whole file exists to prevent. A control's name is now
    taken from `aria-label` when it has one, which is also where a name has to be for anyone not
    looking at pixels; the visible text is the fallback. A control with neither is unnamed and is
    reported as such, because a button nobody can name is a button nobody can look up.
    """
    out = {}
    for _, text in surfaces(app):
        for m in BUTTON.finditer(text):
            raw, t = _named(m.group(1), m.group(2))
            if raw is not None:
                out[raw] = t
    return out


def unread(app: str):
    """Every `<button` the careful pass cannot account for — a finding about this tool.

    The crude pass is deliberately dumber: every occurrence of the five characters `<button` in the
    product's shipped files. Each must be the start of a button `labels()` read, or of one it skipped
    for a reason it can state. One that is neither is a control nobody looked at, and a checker that
    reports zero over a surface it never opened is the defect this file has now had twice - once when
    three controls became marks, once when it turned out to be reading one page of six.

    The same mechanism as `tools/htmlcheck.py` and `tools/csscheck.py`, compared by position.
    """
    out = []
    for where, text in surfaces(app):
        seen = {m.start() for m in BUTTON.finditer(text)}
        for m in re.finditer(r'<button', text):
            if m.start() not in seen:
                line = text.count('\n', 0, m.start()) + 1
                out.append(f'{where}:{line} - a control this check never read '
                           f'(no </button>, or built across a boundary a regex cannot cross)')
    return out


MARKED = re.compile(r'<button([^>]*)>\s*<svg class="mk"')


def marked_controls(app: str) -> set:
    """The controls a panel draws as a mark rather than a word, by name."""
    html = (ROOT / f'apps/{app}/sidepanel.html').read_text(encoding='utf-8')
    out = set()
    for attrs in MARKED.findall(html):
        m = re.search(r'aria-label="([^"]+)"', attrs)
        if m:
            out.add(m.group(1))
    return out


def filter_options(app: str) -> set:
    """The named choices in the panel's filter and sort dropdowns.

    This file read `<button>` elements in sidepanel.html and nothing else, so a whole class of
    control was invisible to it: the filter and sort dropdowns are built in JS, from literal pairs
    inside `buildTypeChips()`, and every choice in them is a capability with a name. Adding
    "Has scheduled actions" — the answer to "which workflows do not run immediately" — passed this
    check without the site knowing the feature existed, which is exactly the omission the file is for.

    A "control" here is a thing the user can pick and would search the guide for, so it is the label
    that is compared, not the internal key. `All` is skipped: it is the absence of a filter.
    """
    js = (ROOT / f'apps/{app}/sidepanel.js').read_text(encoding='utf-8')
    out = set()
    m = re.search(r'function buildTypeChips\(\)[\s\S]*?\n}', js)
    if m:
        out |= {label for key, label in re.findall(r"\['([\w-]+)', '([^']+)'\]", m.group(0)) if key != 'all'}
    # ...and the ones written as <option> in the markup, which is where the other panel keeps its
    # sort. Only literal options count: `#ws` and `#gozohodc` are filled from the folder and from
    # the manifest, so their contents are the user's data and Zoho's domains, not our vocabulary -
    # and a select the panel fills in JS simply has none here to read.
    html = (ROOT / f'apps/{app}/sidepanel.html').read_text(encoding='utf-8')
    for sel in re.findall(r'<select\b[^>]*>([\s\S]*?)</select>', html):
        out |= {t.strip() for t in re.findall(r'<option[^>]*>([^<]+)</option>', sel) if t.strip()}
    return {x for x in out if x.lower() not in ('all', '\u2014', '-')}


def guides_depict_marks(findings: list) -> None:
    """A control drawn as a mark must be *drawn* in the guide, not spelled out.

    Naming it is not enough, and that is the gap this closes: `featurecheck` reads `aria-label`, so
    the name was on the site and the check was green while the guide told a reader to press a button
    whose label the panel no longer shows. The person reading these pages is not a developer and has
    no way to translate "Pull all" into a pair of down arrows.

    Reported by the user, which is the failure — the panel and the page changed in the same session
    and only one of them was looked at.
    """
    for app, page in (('crm', 'docs-crm.html'), ('analytics', 'docs-analytics.html')):
        guide = (SITE / page).read_text(encoding='utf-8')
        # every b.ui chip that carries a mark, and what it is called
        depicted = {re.sub(r'<[^>]*>', '', chip).strip()
                    for chip in re.findall(r'<b class="ui">((?:(?!</b>).)*?<svg class="mk".*?)</b>', guide, re.S)}
        for name in sorted(marked_controls(app)):
            if not any(name == d or d.endswith(name) for d in depicted):
                findings.append(f'{page}: “{name}” is a mark in the panel and the guide only spells it out')


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
        opts = filter_options(app)
        for label in sorted(opts):
            if label in EXPECTED_ABSENT:
                continue
            if ALIAS.get(label, label).lower() not in site:
                findings.append(f'{app}: the filter/sort choice “{label}” exists in the panel and is '
                                f'named nowhere on the site')
        blind = unread(app)
        findings[:0] = [f'{app}: {b}' for b in blind]
        print(f'  {app}: {len(found)} named controls across {len(surfaces(app))} shipped files '
              f'and {len(opts)} filter choices, checked against {len(pages)} pages'
              + (f' - {len(blind)} NOT LOOKED AT' if blind else ', none left unread'))

    guides_depict_marks(findings)

    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). Every control the panel offers must be findable on the site.'
          if findings else
          '0 findings. The site names every control both panels offer.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
