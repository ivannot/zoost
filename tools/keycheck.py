#!/usr/bin/env python3
"""A control a mouse can use and a keyboard cannot.

    python3 tools/keycheck.py            # report clickable markup no keyboard can reach
    python3 tools/keycheck.py --accept   # record what is there now as read

**The rule it holds.** Anything that responds to a click is a control, and a control has to be
reachable by Tab and answer Enter. The browser gives that away for free to `<button>`, `<a href>`,
`<input>`, `<select>`, `<textarea>` and `<summary>`; it gives *nothing* to a `<span>` or a `<div>`
with a click handler on it, and nothing to an `<a>` with no `href`. Such an element is not merely
awkward from a keyboard - it cannot be focused at all, so the action behind it has no keyboard
equivalent whatsoever.

Reported by the author on 14 September 2026, from the outside: «questa modalità di dichiarare i
pulsanti impedirebbe l'utilizzo da tastiera». He was right, and the reason it had survived is worth
more than the count: **nothing here could see these controls.** `featurecheck.py` exists to prove the
site names every control the panels have, and it enumerates `<button ...>...</button>` and nothing
else - so a `<span>` that closes a dialog was never a control to it, and neither its careful pass nor
its own cruder denominator could notice. Numerator and denominator shared one blind spot.

**Why a checker and not a line in `CLAUDE.md`.** The same reason as everywhere else here: a rule with
a check behind it has held, and a rule living only as prose has been broken, usually by whoever had
just read it. This one is especially easy to break, because a `<span>` styled to look like a button
*is* a button to the person writing it.

**It is a ledger**, like `tools/cssdupes.txt` and `tools/asyncglobals.txt`: what is clickable and
unreachable today is recorded in `tools/keyreach.txt`, anything new is a finding, and converting a
control makes its entry vanish - which is a finding too, in the other direction, so the record cannot
quietly stop being a record of anything. It should shrink; a run that grows it says which of the two
reasons the reader has to be able to name.

**What it cannot do, stated rather than left to be found.** It reads static markup and the `$('id')`
wiring beside it, so three things are outside it and none of them is small:

  - **markup built in JavaScript** - rows, chips, tree nodes, diagram boxes - which is where most of
    this repository's clickable spans actually live;
  - **delegated handlers**, where a container listens and `closest('.cls')` decides, so no id is ever
    named;
  - **an element made reachable by other means** - a container that holds the focus and moves a
    selection with the arrow keys, which is how both panels' lists already work. An element carrying
    `tabindex` is taken at its word here and not judged further.

So it is a net over the fixed chrome, not a proof about the product. The generated half needs a
different instrument, and saying otherwise would be the kind of reassurance this repository refuses.
"""
import hashlib
import pathlib
import re
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ledger import delta as ledger_delta, count as ledger_count, keep_comments  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER_REL = 'tools/keyreach.txt'
LEDGER = ROOT / LEDGER_REL

APPS = ('crm', 'analytics')
PAGES = ('workbench.html', 'graphview.html', 'options.html')

# What the browser makes focusable without being asked. `<a>` is here only when it carries an href:
# an anchor without one is a span wearing a different name, and both panels have two of those.
NATIVE = {'button', 'input', 'select', 'textarea', 'summary'}

# The careful pass: an element, its tag, its id. Every tag, deliberately - the first version of this
# sweep looked inside <span> and <a> only, and therefore could not see #scrim, a <div> that closes
# two dialogs. A sweep that cannot produce a positive is not evidence.
ELEMENT = re.compile(r'<(\w+)\b([^>]*?)\bid="([^"]+)"([^>]*)>')
# The crude pass, dumber on purpose: every id attribute in the file, however it is written. Its only
# job is to be a denominator the careful pass cannot quietly shrink.
ANY_ID = re.compile(r'\bid="[^"]+"')


def wired(js: str, eid: str) -> bool:
    """Does anything give this id a click? Asked of the code, not of a reading of the code."""
    q = re.escape(eid)
    return bool(re.search(rf"\$\('{q}'\)\s*\.onclick"
                          rf"|\$\('{q}'\)\.addEventListener\('click'"
                          rf"|getElementById\('{q}'\)\s*\.onclick"
                          rf"|getElementById\('{q}'\)\.addEventListener\('click'", js))


def sources(app: str) -> str:
    """Every script that ships with a panel, as one text: the wiring for one page is spread across
    them, and which file holds which control is not something this check should have an opinion
    about."""
    return '\n'.join(p.read_text(encoding='utf-8')
                     for p in sorted((ROOT / 'apps' / app).glob('*.js')))


def key(rel: str, eid: str) -> str:
    """A ledger entry is an id **and** a place. Editing the markup around a control keeps it
    recorded - the entry is about the control, not about the line it sits on - and the same id in a
    second page is its own entry, because reaching it there is its own question."""
    return hashlib.sha256((rel + '\x00' + eid).encode('utf-8')).hexdigest()[:16]


def scan():
    """(findings, inspected, seen) - what is clickable and unreachable, and the two counts that say
    how much of the subject was actually read."""
    found, inspected, seen = [], 0, 0
    for app in APPS:
        js = sources(app)
        for page in PAGES:
            path = ROOT / 'apps' / app / page
            if not path.exists():
                continue
            html = path.read_text(encoding='utf-8')
            rel = path.relative_to(ROOT).as_posix()
            seen += len(ANY_ID.findall(html))
            read_at = set()
            for m in ELEMENT.finditer(html):
                tag, eid = m.group(1).lower(), m.group(3)
                attrs = m.group(2) + m.group(4)
                inspected += 1
                read_at.add(m.start(3))
                if tag in NATIVE or (tag == 'a' and 'href=' in attrs) or 'tabindex' in attrs:
                    continue
                if not wired(js, eid):
                    continue
                line = html.count('\n', 0, m.start()) + 1
                found.append((rel, line, tag, eid))
    return found, inspected, seen


def unread():
    """Positions the crude pass sees and the careful one never read - a finding about this tool.

    The mechanism `htmlcheck` and `featurecheck` already use here: counts prove nothing, because a
    crude count is either short or long, while positions are checkable. It is printed above any
    finding about the code, because a checker reporting zero over markup it never opened is the
    defect this file exists to avoid repeating.
    """
    out = []
    for app in APPS:
        for page in PAGES:
            path = ROOT / 'apps' / app / page
            if not path.exists():
                continue
            html = path.read_text(encoding='utf-8')
            rel = path.relative_to(ROOT).as_posix()
            careful = {m.start(3) - len('id="') for m in ELEMENT.finditer(html)}
            for m in ANY_ID.finditer(html):
                if m.start() not in careful:
                    line = html.count('\n', 0, m.start()) + 1
                    out.append(f'  {rel}:{line} - an id this check never read '
                               f'(no closing >, or an element built across a boundary a regex cannot cross)')
    return out


def read_ledger() -> dict:
    if not LEDGER.exists():
        return {}
    out = {}
    for row in LEDGER.read_text(encoding='utf-8').splitlines():
        if row.startswith('#') or not row.strip():
            continue
        k, _, rest = row.partition('  ')
        out[k] = rest
    return out


def main() -> int:
    accept = '--accept' in sys.argv
    found, inspected, seen = scan()
    blind = unread()

    if accept:
        own = ['# Derived by tools/keycheck.py - do not edit by hand; run it with --accept.',
               '# Each line is a control a mouse can use and a keyboard cannot reach: clickable',
               '# markup that is not a button, a link, a field, or anything carrying tabindex.',
               '# Being here means it is known and not yet fixed. It should shrink; growth is printed.']
        rows = own + keep_comments(LEDGER, own)
        for rel, _, tag, eid in found:
            rows.append(f'{key(rel, eid)}  {rel}: <{tag} id="{eid}">')
        before = ledger_count(LEDGER)
        LEDGER.write_text('\n'.join(rows) + '\n', encoding='utf-8')
        print(ledger_delta(f'keycheck: {LEDGER_REL}', before, ledger_count(LEDGER)))
        return 0

    ledger = read_ledger()
    new = [f for f in found if key(f[0], f[3]) not in ledger]
    here = {key(rel, eid) for rel, _, _, eid in found}
    gone = [k for k in ledger if k not in here]

    for row in blind:
        print(row)
    for rel, line, tag, eid in new:
        print(f'  {rel}:{line}: <{tag} id="{eid}"> is clicked and cannot be focused - '
              f'no keyboard reaches it')
    for k in gone:
        print(f'  the ledger records a control that is no longer unreachable: {ledger[k]} - '
              f'run --accept in the same change')

    total = len(new) + len(gone) + len(blind)
    print()
    print(f'  {inspected} element(s) with an id read of {seen} id attribute(s) in '
          f'{len(APPS) * len(PAGES)} page(s), none left unread'
          if not blind else
          f'  {inspected} element(s) with an id read of {seen} id attribute(s) - '
          f'{len(blind)} NOT read, reported above')
    if total:
        print(f'{total} finding(s). A control a mouse can use is a control a keyboard must reach.')
    else:
        print(f'0 findings. {len(found)} clickable element(s) reach no keyboard, all of them recorded.')
    return 1 if total else 0


if __name__ == '__main__':
    raise SystemExit(main())
