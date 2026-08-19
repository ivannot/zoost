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

Checks 5 and 6 cover behaviour, which the first four are blind to: markup and CSS can match while a
control does nothing on one side. Check 5 compares which shared controls have a handler and of what
event type. Check 6 compares which platform and DOM techniques each panel uses **at all** — if one
resets a scroll position and the other never does anywhere, that is worth a look.

Both are approximations. What a handler *does* is not statically comparable, so check 6 is a smell
detector at file granularity, not a proof: it would have caught the detail pane keeping its scroll
position, and would not have caught the search box failing to take focus back, because that file
used `focus` elsewhere. Know which of the two a finding is before trusting it.

It decides nothing. A difference may be deliberate — say so below, with the reason on the line.

    python3 tools/twincheck.py            # everything not declared product-specific
    python3 tools/twincheck.py --all      # everything, declarations ignored
    python3 tools/twincheck.py --accept   # record the twin-function ledger as read
"""
import hashlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jstext import strip_js  # noqa: E402 - one scanner, two checkers

ROOT = Path(__file__).resolve().parent.parent
# This compares the two side panels, and only those: it is a structural diff of one page against
# its twin, and graphview/options have different shapes rather than shared chrome.
#
# That is a real limit and it cost something. Two files out of the twelve each app ships were the
# only ones any check ever read, so an Analytics window titled after the CRM survived from the day
# the graph engine was ported. `tools/namecheck.py` covers *every* shipped file for the one property
# that must hold across all of them — that a file names its own product and no other — and it globs
# rather than holding a list, so a file added tomorrow is covered without anyone remembering.
PANELS = {'crm': ROOT / 'apps/crm/sidepanel.html', 'analytics': ROOT / 'apps/analytics/sidepanel.html'}
# The CRM panel is composed of two classic scripts since the split - one shared scope on the page -
# so «the panel's code» is their concatenation, or every AI function reads as removed on one side.
SCRIPTS = {'crm': [ROOT / 'apps/crm/sidepanel.js', ROOT / 'apps/crm/ai.js', ROOT / 'apps/crm/export.js'],
           'analytics': [ROOT / 'apps/analytics/sidepanel.js']}

# Same structural element, different name. The divergence is real and worth removing one day; until
# then it is declared here so the tool compares them as the one thing they are.
EQUIV = {
    'belowbar': 'main',      # the container the AI and Health overlays cover
    'tree': 'list',          # the scrolling list of items
    'preview': 'detail',     # the pane below the draggable split
    'findx': 'findclear',    # the search box's clear affordance
    'chiprow': 'filterrow',  # the row of filters the history view replaces: chips there, selects here
    # The history controls. Named after the pane each sits in - `pv` for the CRM's preview, `d` for
    # the Analytics detail - which is the same divergence as #preview / #detail one line up, so it
    # is declared the same way rather than renamed on one side alone.
    'pvback': 'dback',       # back one step
    'pvfwd': 'dfwd',         # forward one step
    'pvchain': 'dchain',     # the chain itself, to jump to a step
    'pvchainmenu': 'dchainmenu',
}

# Elements that exist in one product because the other has no such concept. Each owes a reason.
PRODUCT_ONLY = {
    'crm': {
        'healthpull': 'one group in the CRM health view is read from Zoho at runtime and needs its own '
                      'refresh; the Analytics health view is computed from the mirror end to end',
        'healthmsg': 'what the CRM health view says about its own Pull, beside it - the status line '
                     'is inside #belowbar and this view covers it',
        'funcs': 'the functions view',
        'missing': 'per-type "complete missing"; Analytics retries failed items instead',
        'pullone': 'per-type pull; Analytics pulls one view from its detail pane',
        'smode': 'search scope, names vs source text — no source to search here',
        'stxt': 'ditto',
        'nameToggle': 'internal vs display name, a CRM-only distinction',
        'navname': 'the same distinction inside the history view; a Zoho Analytics view has one name',
        'typechips': 'the old chip row, replaced by a picklist',
        'modebar': 'the segment row for the five CRM types; Analytics has one list and a type filter',
        'scstale': 'per-area staleness: only the CRM pulls its areas separately, so only there can one fall behind',
    },
    'analytics': {
        'typesel': 'the type picklist; the CRM builds its own dynamically',
        'sort': 'the sort picklist; the CRM builds its own dynamically',
        'sortdir': 'ditto — the CRM creates the direction button in JS',
        'retry': 'retry failed items; the CRM has #missing for the same idea',
        'statustext': 'the CRM writes into #status directly instead of a child span',
        'dbody': 'detail pane body',
        'dzoho': 'opens this view in Zoho Analytics by its own address - /workspace/<id>/view/<id>, '
                 'one shape for every kind of view. The CRM has no equivalent on purpose: its «Go to» '
                 'drove the editor through a localized label and was removed in 1.1.0, and what stands '
                 'in its place is #pvfind, which filters the functions list and leaves the last click '
                 'to the reader',
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
    ('.znav', 'background'): 'znav is the accent\'s light sibling, so it follows the product colour',
    ('.znav', 'border'): 'ditto',
    ('.znav', 'color'): 'ditto',
    ('.znav:hover:not(:disabled)', 'background'): 'ditto',
    ('.znav:hover:not(:disabled)', 'color'): 'ditto',
    ('.aimsg.user .aitext', 'background'): 'the user bubble sits on the accent',
    ('button.primary:hover:not(:disabled)', 'background'): 'the hover of each product accent',
    (':root', '--sel'): 'the product colour: blue in CRM, teal in Analytics',
    (':root', '--sel-soft'): 'ditto, its soft variant',
    (':root', '--rest'): 'a CRM-only token, for REST-enabled functions',
    ('button', 'white-space'): 'Analytics buttons never wrap; the CRM handles it per button',
    ('button.primary', 'font-weight'): 'the Analytics primary is bold; the CRM inherits its weight',
    ('.zbtn:hover:not(:disabled)', 'background'): 'the hover of each product accent',
    ('.zbtn:hover:not(:disabled)', 'border-color'): 'ditto',
    ('.aimsg.user .aitext', 'color'): 'a light tint of each product accent',
    (':root', '--accent'): 'the accent is the product colour: blue in CRM, teal in Analytics',
    ('#healthbody', 'flex'): 'the Analytics health view is a flex column and its body must fill it',
    ('#healthbody', 'color'): 'base typography, which the CRM inherits from elsewhere',
    ('#healthbody', 'font-size'): 'ditto',
    ('#healthbody', 'padding'): 'the CRM health view has a sticky tab row inside this box, so the top padding had to move onto the row itself or the coverage line scrolls up into the gap above it; the Analytics health view has nothing sticky in it',
    ('#healthbody', 'line-height'): 'ditto',
}
EXPECTED_SOLO = {
    '#healthview .hhr': 'the row holding the CRM health view own Pull, which Analytics has no reason '
                        'for - nothing in its health view is read from the platform',
    '.bar': 'the CRM has a per-mode button row; Analytics has no modes',
    '.dtab:disabled': 'Analytics disables a detail tab when the selection cannot be projected into '
                      'it; the CRM has two - Code and Details - and both always apply to a function',
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
def handlers(js):
    """Which shared controls have behaviour attached, and of what kind.

    The dimension the first three checks were blind to: markup and CSS can match perfectly while a
    control does nothing on one side. It found the detail pane keeping its scroll position when the
    CRM's resets it, and a search box that did not take focus back after being cleared.
    """
    out = {}
    for m in re.finditer(r"\$\('([\w-]+)'\)\.(on\w+)\s*=", js):
        out.setdefault(canon(m.group(1)), set()).add(m.group(2))
    for m in re.finditer(r"\$\('([\w-]+)'\)\.addEventListener\('(\w+)'", js):
        out.setdefault(canon(m.group(1)), set()).add('on' + m.group(2))
    return out


def idioms(js):
    """Platform and DOM techniques each panel uses at all.

    Handler *types* can match while what the handler does does not, and that is not statically
    comparable in general. This is the useful approximation: if one panel resets a scroll position
    and the other never does anywhere, that is worth a look. Derived by pattern, not from a list.
    """
    out = set()
    for m in re.finditer(r'\bchrome\.(\w+)\.(\w+)\(', js):
        out.add(f'chrome.{m.group(1)}.{m.group(2)}()')
    for m in re.finditer(r'\b(window|document)\.addEventListener\(\s*[\'"](\w+)', js):
        out.add(f'{m.group(1)}.on{m.group(2)}')
    for m in re.finditer(r'\.(scrollTop|scrollLeft|scrollIntoView|focus|blur|select)\b', js):
        out.add(f'.{m.group(1)}')
    for kw in ('requestAnimationFrame', 'confirm(', 'AbortSignal', 'structuredClone'):
        if kw in js:
            out.add(kw.rstrip('('))
    return out


# Idioms one product uses and the other has no occasion for, with the reason.
EXPECTED_IDIOM = {
    'chrome.tabs.get()': 'the CRM waits for a tab to finish loading; Analytics never navigates and waits',
    'chrome.tabs.reload()': 'the CRM re-injects by reloading the Zoho tab in one recovery path',
    'window.onresize': 'the CRM re-fits its segment row when the panel is dragged narrower; Analytics '
                       'has one list and a type filter, so it has no row that can wrap',
}

# Behaviours that exist in one product only, with the reason.
EXPECTED_BEHAVIOUR = {
    'pull': set(), 'find': set(),
}


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


# ---------------------------------------------------------------------------------------------
# Check 7: the code the two products hold in common, and whether it has drifted.
#
# No code is shared between the apps, by decision (CLAUDE.md): two products still finding their
# form pay more for a premature abstraction than for the copy. The bill for that decision is real
# and has been paid at least once - when the force layout was rewritten, `settle()` was carried to
# the other side by hand, and it got there because somebody remembered.
#
# So the duplication is not removed, it is **held**. Every function name present in both products
# is recorded in tools/twins.txt with a hash of each side's body, and a one-sided change is
# reported. That converts "fixed on one side only" from silent into stated, without touching the
# architecture - which matters here because the extensions are loaded unpacked, so a shared folder
# assembled at build time would exist in the package and not in the tree being developed.
#
# It is a ledger, not an allow-list. Nothing is listed by hand: a function that becomes a twin
# tomorrow is recorded without anyone remembering, and the failure mode an allow-list has - forget
# to add something and it goes unchecked - cannot happen. `--accept` records the current state
# after it has been read, the same differential shape as tools/absolutes.txt.
#
# What it catches and what it does not, said rather than left to be found. A one-sided change is the
# obvious case. The expensive one is a fix applied to both copies *differently* - it looks like
# diligence, both files edited in one commit - and that is caught too now: a pair that was
# byte-identical and is no longer is a finding, whichever side moved. What stays outside is a pair
# that was *already* divergent and moves again: those are two functions sharing a name, and telling
# them to agree would be this file inventing a rule the code never had.
#
# This paragraph said the opposite until the day the check was written, which is its own lesson: a
# comment describing a hole outlives the hole, and reads as current.
LEDGER = ROOT / 'tools/twins.txt'


def functions(js):
    """Top-level function bodies, whitespace-collapsed. A regex over declarations plus a brace walk:
    the panels are plain scripts with no nesting worth chasing, and a parser would be the first
    dependency in a repository whose pitch is that it has none."""
    src = strip_js(js)
    out = {}
    for m in re.finditer(r'^(?:async )?function (\w+)\s*\(', src, re.M):
        i = src.index('{', m.end() - 1)
        depth, j = 0, i
        while j < len(src):
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out[m.group(1)] = re.sub(r'\s+', ' ', src[i:j + 1])
    return out


def twins():
    """Every function name both products define, with each side's body hash. The file set is
    globbed, so a script added tomorrow is covered."""
    side = {}
    for app in ('crm', 'analytics'):
        seen = {}
        for f in sorted((ROOT / 'apps' / app).glob('*.js')):
            for name, body in functions(f.read_text(encoding='utf-8')).items():
                seen[name] = (hashlib.sha256(body.encode()).hexdigest()[:12], len(body))
        side[app] = seen
    return {n: (side['crm'][n], side['analytics'][n]) for n in sorted(set(side['crm']) & set(side['analytics']))}


def drift_report(now, was):
    """What the ledger says has happened to the twin functions since it was last read.

    A function rather than a loop inside main() because it is the part of this checker with rules
    in it, and a checker that reports success over the thing it exists to catch is worse than none
    - which this repository has already had happen twice. Pure: two ledgers in, lines out.
    """
    drift, fresh, both = [], [], 0
    for name, ((ac, _), (bc, _)) in sorted(now.items()):
        if name not in was:
            fresh.append(name)
            continue
        moved = [s for s, o, n in (('crm', was[name][0], ac), ('analytics', was[name][1], bc)) if o != n]
        if len(moved) == 1:
            other = 'analytics' if moved[0] == 'crm' else 'crm'
            what = 'was identical, now differs' if was[name][0] == was[name][1] else 'changed'
            drift.append(f'  {name:24s} {what} - {moved[0]} moved, {other} did not')
        elif moved:
            # Both sides moved, which is the twin rule being honoured - unless they moved *apart*.
            # Only the number of sides that moved used to be compared, never where they arrived, so
            # the one case worth catching read exactly like the good one: a pair that was
            # byte-identical, got the same fix twice, and got it twice *differently*. That shape is
            # expensive because it looks like diligence - both files edited, both in the same commit
            # - and the difference between the copies is now something nobody chose. A one-sided
            # change at least announces itself as half-done; this announced itself as finished.
            #
            # Worse than under-reported, it was mis-routed: the line below says «read them, then
            # --accept», so following the checker's own advice recorded the divergence as the new
            # normal. Measured by planting exactly that defect against the previous version.
            #
            # Only the identical -> divergent transition is a finding. A pair that was already
            # divergent is two functions that share a name, and telling them to agree would be the
            # check inventing a rule the code never had; a pair that was divergent and is now
            # identical is somebody reconciling them, which is the outcome this file wants.
            if was[name][0] == was[name][1] and ac != bc:
                drift.append(f'  {name:24s} was identical - both sides moved, and they no longer agree')
            else:
                both += 1
    for name in sorted(set(was) - set(now)):
        drift.append(f'  {name:24s} no longer a twin - removed or renamed on one side')
    # A pair that moved on both sides honoured the twin rule, so it is not a drift. But leaving it
    # unrecorded is not harmless: the next one-sided change would then be measured against a state
    # two commits old and read as having moved on both sides too, which is silence exactly where
    # this check is supposed to speak. So being behind is itself a finding, cleared by --accept.
    if both:
        drift.append(f'  the ledger is {both} pair(s) behind - both sides moved; read them, then --accept')
    if fresh and was:
        drift.append(f'  {len(fresh)} new twin function(s) not in the ledger: {", ".join(fresh[:6])}'
                     + (' …' if len(fresh) > 6 else ''))
    return drift


def read_ledger():
    if not LEDGER.exists():
        return {}
    out = {}
    for line in LEDGER.read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        name, a, b = line.split('\t')[:3]
        out[name] = (a, b)
    return out


def write_ledger(now):
    lines = [
        '# Derived by tools/twincheck.py - do not edit by hand; run it with --accept.',
        '# Every function name both products define, with a hash of each side\'s body. A one-sided',
        '# change is a fix that landed on one twin and not the other, which is what this catches.',
        '# name\tcrm\tanalytics\tstate',
    ]
    for name, ((ac, _), (bc, _)) in sorted(now.items()):
        lines.append(f'{name}\t{ac}\t{bc}\t{"identical" if ac == bc else "divergent"}')
    LEDGER.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    every = '--all' in sys.argv
    accept = '--accept' in sys.argv
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

    js = {k: '\n'.join(f.read_text(encoding='utf-8') for f in fs) for k, fs in SCRIPTS.items()}
    hnd = {k: handlers(v) for k, v in js.items()}
    print('\n== shared controls whose attached behaviour differs ==')
    bdiffs = []
    for eid in sorted(set(ids['crm']) & set(ids['analytics'])):
        a2, b2 = hnd['crm'].get(eid, set()), hnd['analytics'].get(eid, set())
        if a2 != b2 and (a2 or b2):
            miss = ', '.join(sorted(a2 - b2)) or '—'
            extra = ', '.join(sorted(b2 - a2)) or '—'
            bdiffs.append(f'  {eid:16s} crm-only: {miss:24s} analytics-only: {extra}')
    print('\n'.join(bdiffs) if bdiffs else '  none')
    findings += len(bdiffs)

    idm = {k: idioms(v) for k, v in js.items()}
    print('\n== platform / DOM idioms used on one side only ==')
    idiff = []
    for a2, b2 in (('crm', 'analytics'), ('analytics', 'crm')):
        for k in sorted(idm[a2] - idm[b2]):
            if every or k not in EXPECTED_IDIOM:
                idiff.append(f'  {k:40s} only in {a2}')
    print('\n'.join(idiff) if idiff else '  none')
    findings += len(idiff)

    print('\n== code the two products hold in common ==')
    now, was = twins(), read_ledger()
    ident = {n: v for n, v in now.items() if v[0][0] == v[1][0]}
    chars = sum(v[0][1] for v in ident.values())
    print(f'  {len(now)} function names defined in both products; {len(ident)} byte-identical '
          f'({chars:,} characters of deliberate copy) - tools/twins.txt holds them')
    drift = drift_report(now, was)
    print('\n'.join(drift) if drift else '  no one-sided change, and the ledger is current')
    if not was:
        print(f'  (first run: {len(now)} pairs recorded)')
    findings += len(drift)
    if accept:
        write_ledger(now)
        print(f'  ledger written: {LEDGER.relative_to(ROOT)}')

    print('\n== declared deliberate ==')
    for k, v in sorted(EQUIV.items()):
        print(f'  #{k} = #{v} — same element, different name; worth unifying one day')
    for (sel, prop), why in sorted(EXPECTED.items()):
        print(f'  {sel} {{{prop}}} — {why}')
    for sel, why in sorted(EXPECTED_SOLO.items()):
        print(f'  {sel} (one side only) — {why}')

    print(f'\n{findings} undeclared difference(s). Each is deliberate or a drift — decide, do not skip.')
    # Its four siblings have always returned 1 on a finding; this one returned 0, so `tests/run.sh`
    # ran it and could not fail on it. That was invisible while it printed zero, and would have
    # stayed invisible exactly when it stopped - including for the twin ledger, which is only
    # worth keeping if being behind is something a run can refuse to pass.
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
