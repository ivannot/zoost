#!/usr/bin/env python3
"""
twincheck.py — mechanically diff the two Zoost panels.

The apps are twins (see CLAUDE.md). Everything they have in common must be the same thing on both
sides. Checking that from memory does not work, and neither does a checklist: a checklist only ever
holds the mistakes already made, so the next drift is always in a dimension nobody thought to list.
That failure repeated often enough to be worth engineering away.

**The lists here are of what is deliberately different, not of what to check.** Everything else is
compared. Forgetting to declare something makes it *reported*, never silent — the only direction
that fails safe. The first two versions had it the other way round: one stayed quiet about a button
that was visibly wrong because the rule styling it existed on one side only, and the next stayed
quiet about a missing resizer because nobody had added it to a list of things worth comparing.

Checks:
  1. elements present on one side only
  2. shared elements whose tag, class or inline style differs
  3. shared CSS rules whose declarations differ
  4. CSS rules that exist on one side only

It decides nothing. A difference may be deliberate — say so below, with the reason on the line.

    python3 tools/twincheck.py            # everything not declared product-specific
    python3 tools/twincheck.py --all      # everything, declarations ignored
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PANELS = {'crm': ROOT / 'apps/crm/sidepanel.html', 'analytics': ROOT / 'apps/analytics/sidepanel.html'}

# Same structural element, different name. The divergence is real and worth removing one day; until
# then it is declared here so the tool compares them as the one thing they are.
EQUIV = {
    'belowbar': 'main',      # the container the AI and Health overlays cover
    'tree': 'list',          # the scrolling list of items
    'preview': 'detail',     # the pane below the draggable split
    'findx': 'findclear',    # the search box's clear affordance
}

# Elements that exist in one product because the other has no such concept. Each owes a reason.
PRODUCT_ONLY = {
    'crm': {
        'funcs': 'the functions view',
        'missing': 'per-type "complete missing"; Analytics retries failed items instead',
        'pullone': 'per-type pull; Analytics pulls one view from its detail pane',
        'smode': 'search scope, names vs source text — no source to search here',
        'stxt': 'ditto',
        'nameToggle': 'internal vs display name, a CRM-only distinction',
        'typechips': 'the old chip row, replaced by a picklist',
    },
    'analytics': {
        'typesel': 'the type picklist; the CRM builds its own dynamically',
        'sort': 'the sort picklist; the CRM builds its own dynamically',
        'sortdir': 'ditto — the CRM creates the direction button in JS',
        'retry': 'retry failed items; the CRM has #missing for the same idea',
        'statustext': 'the CRM writes into #status directly instead of a child span',
        'dbody': 'detail pane body',
        'dclose': 'detail pane close',
        'dgraph': 'open the ER diagram focused on this table',
        'dpull': 'pull this one view',
        'dtitle': 'detail pane title',
    },
}
PRODUCT_PREFIX = {
    'crm': {'m': 'mode segments (Functions/Modules/…)', 'pv': 'the source preview', 'sc_': 'export scope keys'},
    'analytics': {'sc_': 'export scope keys', 'tab_': 'detail pane tabs'},
}

# Declarations that differ on purpose.
EXPECTED = {
    ('.zbtn', 'color'): 'teal needs dark text for contrast where blue needs white',
    ('button.primary:hover:not(:disabled)', 'background'): 'the hover of each product accent',
    (':root', '--sel'): 'the product colour: blue in CRM, teal in Analytics',
    (':root', '--sel-soft'): 'ditto, its soft variant',
    (':root', '--rest'): 'a CRM-only token, for REST-enabled functions',
    ('button', 'white-space'): 'Analytics buttons never wrap; the CRM handles it per button',
    ('button.primary', 'color'): 'same contrast reason as .zbtn',
    ('button.primary', 'font-weight'): 'ditto',
    ('.zbtn:hover:not(:disabled)', 'background'): 'the hover of each product accent',
    ('.zbtn:hover:not(:disabled)', 'border-color'): 'ditto',
    ('.aimsg.user .aitext', 'color'): 'dark text on teal, light text on blue — same reason as .zbtn',
    (':root', '--accent'): 'the accent is the product colour: blue in CRM, teal in Analytics',
    ('#healthbody', 'flex'): 'the Analytics health view is a flex column and its body must fill it',
    ('#healthbody', 'color'): 'base typography, which the CRM inherits from elsewhere',
    ('#healthbody', 'font-size'): 'ditto',
    ('#healthbody', 'line-height'): 'ditto',
}
EXPECTED_SOLO = {
    '.bar': 'the CRM has a per-mode button row; Analytics has no modes',
    '.ck b': 'the Analytics export dialog bolds the section name inside each label',
    '.empty': 'Analytics renders empty states as .empty blocks; the CRM uses its own markup',
    '.empty b': 'ditto',
    '.empty code': 'ditto',
    '#healthbody h4': 'the two health views report different things and are structured differently',
    '#healthbody ul': 'ditto',
    '#healthbody li': 'ditto',
    '#healthbody .hnum': 'ditto',
    '#healthbody .gap': 'ditto',
}

# A one-sided CSS rule only matters if its selector touches something both panels actually have.
# A class that exists in one product's markup and not the other's will be one-sided forever, and
# listing them all would be the checklist problem again — so the set of shared classes is derived
# from the two files instead of declared. That way a class used on both sides but styled on only one
# is always reported, which is the case that let the Send button through.
def markup_classes(html):
    out = set()
    for m in re.finditer(r'\bclass="([^"]*)"', html):
        out.update(m.group(1).split())
    return out


DECL_SPLIT = re.compile(r';(?![^(]*\))')


def canon(name):
    return EQUIV.get(name, name)


def product_only(app, eid):
    if eid in PRODUCT_ONLY[app]:
        return PRODUCT_ONLY[app][eid]
    for pre, why in PRODUCT_PREFIX[app].items():
        rest = eid[len(pre):]
        if eid.startswith(pre) and rest and (pre.endswith('_') or len(pre) > 1 or rest[0].isupper()):
            return why
    return None


def styles(html):
    return '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S))


def rules(css):
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    out = {}
    for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', css):
        sel = ' '.join(sel.split())
        if not sel or sel.startswith('@') or re.fullmatch(r'[\d.%,\s]+|from|to', sel):
            continue        # keyframe stops are not selectors; "0%" in two different animations is not a shared rule
        decls = {}
        for d in DECL_SPLIT.split(body):
            if ':' in d:
                k, _, v = d.partition(':')
                decls[k.strip()] = ' '.join(v.split())
        for s in sel.split(','):
            s = ' '.join(s.split())
            if not s:
                continue
            s = re.sub(r'#([\w-]+)', lambda m: '#' + canon(m.group(1)), s)
            out.setdefault(s, {}).update(decls)
    return out


def id_attrs(html):
    out = {}
    for m in re.finditer(r'<(\w+)([^>]*\bid="([^"]+)"[^>]*)>', html):
        tag, attrs, eid = m.group(1), m.group(2), m.group(3)
        cls = re.search(r'\bclass="([^"]*)"', attrs)
        sty = re.search(r'\bstyle="([^"]*)"', attrs)
        out[eid] = {'tag': tag, 'class': ' '.join((cls.group(1) if cls else '').split()),
                    'style': ' '.join((sty.group(1) if sty else '').split()), 'raw': eid}
    return out


def touches_shared(sel, shared_cls, shared_ids):
    """Anchor on the FIRST class or id of the FIRST token — the thing the rule is really about.
    `.dtab.active` is about .dtab, not about .active; treating any shared token as an anchor made
    every product-specific rule with a generic modifier look shared."""
    first = sel.split()[0] if sel.split() else ''
    ids_in = re.findall(r'#([\w-]+)', first)
    cls_in = re.findall(r'\.([\w-]+)', first)
    if ids_in:
        return canon(ids_in[0]) in shared_ids
    if cls_in:
        return cls_in[0] in shared_cls
    return True                       # a bare element selector (button, select, …) is shared by nature


def selector_is_product_only(sel):
    for tok in sel.split():
        if not tok.startswith('#'):
            continue
        eid = tok.lstrip('#').split(':')[0].split('.')[0]
        for app in ('crm', 'analytics'):
            if product_only(app, eid):
                return True
    return False


def main():
    every = '--all' in sys.argv
    html = {k: p.read_text(encoding='utf-8') for k, p in PANELS.items()}
    css = {k: rules(styles(v)) for k, v in html.items()}
    raw = {k: id_attrs(v) for k, v in html.items()}
    ids = {k: {canon(e): v for e, v in d.items()} for k, d in raw.items()}
    findings = 0

    print('== elements present on one side only ==')
    only = []
    for a, b in (('crm', 'analytics'), ('analytics', 'crm')):
        for eid in sorted(set(ids[a]) - set(ids[b])):
            if every or not product_only(a, ids[a][eid]['raw']):
                only.append(f'  {eid:16s} in {a}, absent from {b}')
    print('\n'.join(only) if only else '  none')
    findings += len(only)

    print('\n== shared elements whose tag, class or inline style differs ==')
    diffs = []
    for eid in sorted(set(ids['crm']) & set(ids['analytics'])):
        a, b = ids['crm'][eid], ids['analytics'][eid]
        for field in ('tag', 'class', 'style'):
            if a[field] != b[field]:
                diffs.append(f'  {eid:16s} {field:6s} crm={a[field]!r}  analytics={b[field]!r}')
    print('\n'.join(diffs) if diffs else '  none')
    findings += len(diffs)

    print('\n== shared CSS rules whose declarations differ ==')
    cdiffs = []
    for sel in sorted(set(css['crm']) & set(css['analytics'])):
        a, b = css['crm'][sel], css['analytics'][sel]
        keys = sorted(set(a) | set(b))
        parts = [f'{k}: {a.get(k, "—")} | {b.get(k, "—")}' for k in keys if a.get(k) != b.get(k)]
        parts = [p for p in parts if 'var(--sel)' not in p]
        if not every:
            parts = [p for p in parts if (sel, p.split(':')[0]) not in EXPECTED]
        if parts:
            cdiffs.append(f'  {sel}\n' + '\n'.join('      ' + p for p in parts))
    print('\n'.join(cdiffs) if cdiffs else '  none')
    findings += len(cdiffs)

    shared_cls = markup_classes(html['crm']) & markup_classes(html['analytics'])
    shared_ids = set(ids['crm']) & set(ids['analytics'])
    print('\n== CSS rules on one side only ==')
    solo = []
    for a, b in (('crm', 'analytics'), ('analytics', 'crm')):
        for sel in sorted(set(css[a]) - set(css[b])):
            if not every:
                if sel in EXPECTED_SOLO or selector_is_product_only(sel):
                    continue
                if not touches_shared(sel, shared_cls, shared_ids):
                    continue            # styles something the other panel does not have at all
            solo.append(f'  {sel:44s} only in {a}')
    print('\n'.join(solo) if solo else '  none')
    findings += len(solo)

    print('\n== declared deliberate ==')
    for k, v in sorted(EQUIV.items()):
        print(f'  #{k} = #{v} — same element, different name; worth unifying one day')
    for (sel, prop), why in sorted(EXPECTED.items()):
        print(f'  {sel} {{{prop}}} — {why}')
    for sel, why in sorted(EXPECTED_SOLO.items()):
        print(f'  {sel} (one side only) — {why}')

    print(f'\n{findings} undeclared difference(s). Each is deliberate or a drift — decide, do not skip.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
