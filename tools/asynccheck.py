#!/usr/bin/env python3
"""Every global written after an `await`, and whether anything asked first.

Six external reviews in one day found the same defect six times, in six different functions: a
value read from Zoho or from disk, an `await`, and then a write into a module-level variable - by
which time the workspace on screen may be another one. Each was fixed where it was found, and the
next review found the next instance. That is the shape of a rule that lives only as prose: it is
recalled by resemblance to its own wording, and the seventh instance never resembles it.

So this derives the instances instead. It reads each panel, takes the module-level `let`
declarations as the set of globals, and reports every assignment to one of them that happens after
an `await` **with no check between the two**. A check is anything that can stop the function:
`op.current()`, a generation comparison, `sameWs(...)`, a handle comparison.

What it cannot do, said plainly rather than left to be discovered:

  * It is line-based, not a parser. A guard inside a callback, or a `return` in a branch it cannot
    see, reads as absent.
  * A global written after an await is not automatically wrong. Progress counters, render state and
    caches that belong to no workspace are fine. That is what the ledger is for.
  * It says nothing about *what* the guard checks. A function guarding the wrong thing passes.

It is therefore a ledger, like `tools/cssdupes.txt`: `tools/asyncglobals.txt` holds what is there
today with its reason, anything not in it fails, and **the ledger may only shrink**. A new site is a
finding on the day it is written, which is the whole point - the cost of reading one is minutes, and
the cost of the review that would otherwise find it is a day.

    python3 tools/asynccheck.py            # report; exit 1 on anything not in the ledger
    python3 tools/asynccheck.py --accept   # record the current state as read
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, 'tools', 'asyncglobals.txt')
FILES = ['apps/crm/sidepanel.js', 'apps/analytics/sidepanel.js']

# A check that can stop the function before the write lands.
GUARD = re.compile(r'op\.current\(\)|\bcurrent\(\)|sameWs\(|gen !== wsGen|gen === wsGen'
                   r'|!== myDir|=== myDir|dir !== |root !== dir|!op\b|inSameWorkspace\('
                   # `rebuildTree` carries its own token - `const mine = ++treeLoad` - because what
                   # overtakes a tree load is another tree load, not only a change of workspace.
                   r'|mine === |mine !== ')
# Writing into a global: plain assignment, a member of it, or the mutators a Map/Set/Array carries.
WRITE = re.compile(r'^\s*(?:(\w+)\s*(?:\[[^\]]*\])?(?:\.\w+)*\s*=[^=]'
                   r'|(\w+)\.(?:push|set|clear|delete|add|splice|sort|unshift)\('
                   r'|Object\.assign\((\w+))')


def globals_of(src):
    """Module-level `let` declarations - the mutable state a function can reach from anywhere.

    `const` is not here: a const binding cannot be reassigned, and mutating one that holds a Map or
    a Set is caught by the mutator half of WRITE anyway."""
    names = set()
    for m in re.finditer(r'(?m)^let\s+([^;\n]+)', src):
        for part in m.group(1).split(','):
            n = part.strip().split('=')[0].strip()
            if re.fullmatch(r'\w+', n):
                names.add(n)
    return names


def functions(src):
    """Top-level function declarations, with the line they start on."""
    for m in re.finditer(r'(?m)^(?:async\s+)?function\s+(\w+)\s*\(', src):
        start = src.index('{', m.start())
        end = src.find('\n}', start)
        if end < 0:
            continue
        yield m.group(1), src[m.start():end], src[:m.start()].count('\n') + 1


def findings(rel):
    src = open(os.path.join(ROOT, rel), encoding='utf-8').read()
    names = globals_of(src)
    out = []
    for fname, body, at in functions(src):
        if 'await' not in body:
            continue
        lines = body.split('\n')
        seen_await = False
        since_guard = False      # a guard has been passed since the last await
        for i, line in enumerate(lines):
            code = re.sub(r'//.*$', '', line)
            if seen_await and not since_guard:
                w = WRITE.match(code)
                if w:
                    name = w.group(1) or w.group(2) or w.group(3)
                    if name in names:
                        out.append((rel, fname, name, at + i, code.strip()[:70]))
            if GUARD.search(code):
                since_guard = True
            if re.search(r'\bawait\b', code):
                seen_await = True
                since_guard = bool(GUARD.search(code))
    return out


def read_ledger():
    if not os.path.exists(LEDGER):
        return set()
    keep = set()
    for line in open(LEDGER, encoding='utf-8'):
        line = line.split('#')[0].strip()
        if line:
            keep.add(line)
    return keep


def main():
    accept = '--accept' in sys.argv
    found = []
    for rel in FILES:
        found.extend(findings(rel))
    keys = {f'{rel}\t{fn}\t{name}' for rel, fn, name, _, _ in found}
    known = read_ledger()

    if accept:
        with open(LEDGER, 'w', encoding='utf-8') as fh:
            fh.write('# Derived by tools/asynccheck.py - do not edit by hand; run it with --accept.\n')
            fh.write('# Each line is a global written after an await with no check between the two.\n')
            fh.write('# Being here means somebody read it and decided it is safe. It may only shrink.\n')
            for k in sorted(keys):
                fh.write(k + '\n')
        print(f'asynccheck: recorded {len(keys)} site(s) as read.')
        return 0

    new = sorted(k for k in keys if k not in known)
    gone = sorted(k for k in known if k not in keys)
    for rel, fn, name, line, text in sorted(found):
        if f'{rel}\t{fn}\t{name}' in new:
            print(f'  {rel}:{line}  {fn}() writes `{name}` after an await with nothing asked in between')
            print(f'      {text}')
    for k in gone:
        print(f'  ledger line no longer matches anything: {k.replace(chr(9), " · ")}')
    n = len(new) + len(gone)
    print(f'\n{n} finding(s). {len(keys)} global write(s) after an await, {len(known)} recorded as read.')
    return 1 if n else 0


if __name__ == '__main__':
    sys.exit(main())
