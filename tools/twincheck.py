#!/usr/bin/env python3
"""
twincheck.py — mechanically diff the shared chrome of the two Zoost panels.

The apps are twins (see CLAUDE.md). Everything they have in common must be the same thing on both
sides. Checking that from memory does not work: it produced ten reported divergences, each fixed
after the fact, each followed by one more line in a checklist that was still incomplete.

So this compares them instead of remembering to. It reports three kinds of difference:

  1. shared element ids whose CSS differs
  2. shared element ids present in one panel and absent from the other
  3. shared CSS class rules whose declarations differ

It cannot decide anything: a difference may be deliberate (--sel is teal here and blue there,
Analytics has views where CRM has functions). It only guarantees you are looking at all of them.

    python3 tools/twincheck.py            # shared chrome only
    python3 tools/twincheck.py --all      # everything, including product-specific parts
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANELS = {'crm': ROOT / 'apps/crm/sidepanel.html', 'analytics': ROOT / 'apps/analytics/sidepanel.html'}

# Ids and classes that belong to the shared chrome: workspace management, the environment guard,
# the toolbar, dialogs, the footer. Product-specific ones (functions, views, ER) are not compared.
SHARED_IDS = """wsroot ws wsadd wsdel refresh ctx who bound mmbar mmtext mmsw mmgo mmoverlay
offoverlay gozoho scrim aboutdlg aboutbody aboutx aboutok status pull main pfoot opts about help
expscope expx expcancel expgo pspFull pspSafe scwarn healthview healthbody healthx aiview aimsgs
aiinput aisend aiclear aigear aix aictx ainote ainotetxt ainotex aiengbadge export exportmd health
askai graph""".split()

SHARED_CLASSES = """wsbar wsbar2 wsroot genbar wsgroup expgroup explabel gsep bar spin scrim dlg dh
db df dnote ck preset legal zbtn znav lbtn pbtn abtn rlbl aimsg aitext airole aitool aiwait aiinrow
ainote aictx aimsgs sortdir findwrap chip empty note""".split()

DECL_SPLIT = re.compile(r';(?![^(]*\))')


def styles(html: str) -> str:
    return '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S))


def rules(css: str):
    """selector -> declarations, flattened. Last one wins, as the cascade does."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    out = {}
    for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
        sel = ' '.join(sel.split())
        if not sel or sel.startswith('@'):
            continue
        decls = {}
        for d in DECL_SPLIT.split(body):
            if ':' in d:
                k, _, v = d.partition(':')
                decls[k.strip()] = ' '.join(v.split())
        for s in sel.split(','):
            s = s.strip()
            if s:
                out.setdefault(s, {}).update(decls)
    return out


def id_attrs(html: str):
    """id -> the tag that carries it, with its class and inline style."""
    out = {}
    for m in re.finditer(r'<(\w+)([^>]*\bid="([^"]+)"[^>]*)>', html):
        tag, attrs, eid = m.group(1), m.group(2), m.group(3)
        cls = re.search(r'\bclass="([^"]*)"', attrs)
        sty = re.search(r'\bstyle="([^"]*)"', attrs)
        out[eid] = {'tag': tag, 'class': ' '.join((cls.group(1) if cls else '').split()),
                    'style': ' '.join((sty.group(1) if sty else '').split())}
    return out


def main():
    every = '--all' in sys.argv
    html = {k: p.read_text(encoding='utf-8') for k, p in PANELS.items()}
    css = {k: rules(styles(v)) for k, v in html.items()}
    ids = {k: id_attrs(v) for k, v in html.items()}

    findings = 0

    print('== elements present on one side only ==')
    want = set(SHARED_IDS)
    only = []
    for a, b in (('crm', 'analytics'), ('analytics', 'crm')):
        for eid in sorted(set(ids[a]) - set(ids[b])):
            if every or eid in want:
                only.append(f'  {eid:16s} in {a}, absent from {b}')
    print('\n'.join(only) if only else '  none')
    findings += len(only)

    print('\n== shared elements whose class or inline style differs ==')
    diffs = []
    for eid in sorted(set(ids['crm']) & set(ids['analytics'])):
        if not every and eid not in want:
            continue
        a, b = ids['crm'][eid], ids['analytics'][eid]
        for field in ('tag', 'class', 'style'):
            if a[field] != b[field]:
                diffs.append(f'  {eid:16s} {field:6s} crm={a[field]!r}  analytics={b[field]!r}')
    print('\n'.join(diffs) if diffs else '  none')
    findings += len(diffs)

    # Differences that are deliberate, with the reason. Anything not listed here is drift until
    # someone decides otherwise — and if you add to this list, say why in the same line.
    EXPECTED = {
        ('.zbtn', 'color'): 'teal needs dark text for contrast where blue needs white',
        ('#healthbody', 'flex'): 'the Analytics health view is a flex column and its body must fill it',
        ('#healthbody', 'color'): 'ditto — base typography, which the CRM inherits from elsewhere',
        ('#healthbody', 'font-size'): 'ditto',
        ('#healthbody', 'line-height'): 'ditto',
    }

    print('\n== shared CSS rules whose declarations differ ==')
    cdiffs = []
    for sel in sorted(set(css['crm']) & set(css['analytics'])):
        bare = re.sub(r'[.#]([\w-]+).*', r'\1', sel.split()[0].lstrip('.#'))
        if not every and bare not in SHARED_CLASSES and sel.lstrip('#').split(':')[0] not in SHARED_IDS:
            continue
        a, b = css['crm'][sel], css['analytics'][sel]
        keys = sorted(set(a) | set(b))
        parts = [f'{k}: {a.get(k, "—")} | {b.get(k, "—")}' for k in keys if a.get(k) != b.get(k)]
        # --sel is teal here and blue there on purpose; anything derived from it is expected to differ
        parts = [p for p in parts if 'var(--sel)' not in p]
        parts = [p for p in parts if (sel, p.split(':')[0]) not in EXPECTED]
        if parts:
            cdiffs.append(f'  {sel}\n' + '\n'.join('      ' + p for p in parts))
    print('\n'.join(cdiffs) if cdiffs else '  none')
    findings += len(cdiffs)

    if EXPECTED:
        print('\n== differences recorded as deliberate ==')
        for (sel, prop), why in sorted(EXPECTED.items()):
            print(f'  {sel} {{{prop}}} — {why}')

    print(f'\n{findings} unexplained difference(s) to walk. Each is deliberate or a drift — decide, do not skip.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
