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
# ai.js since the split: same page, same shared scope, same class of state.
# Grouped per page, not per file: classic scripts on one page share a single lexical scope, so a
# write in ai.js to a `let` declared in sidepanel.js is exactly as global as one next to the
# declaration - and reading each file's own declarations alone made those writes invisible the day
# the panel was split. The names are the union of the page's files; the findings stay per file.
PAGES = {
    'crm': ['apps/crm/sidepanel.js', 'apps/crm/ai.js', 'apps/crm/export.js'],
    'analytics': ['apps/analytics/sidepanel.js'],
}
FILES = [f for fs in PAGES.values() for f in fs]

# A check that can stop the function before the write lands.
GUARD = re.compile(r'op\.current\(\)|\bcurrent\(\)|sameWs\(|gen !== wsGen|gen === wsGen'
                   r'|!== myDir|=== myDir|dir !== |root !== dir|!op\b|inSameWorkspace\('
                   # `rebuildTree` carries its own token - `const mine = ++treeLoad` - because what
                   # overtakes a tree load is another tree load, not only a change of workspace.
                   r'|mine === |mine !== ')
# Writing into a global: plain assignment, a member of it, or the mutators a Map/Set/Array carries.
WRITE = re.compile(r'(?:(?<![.\w])(\w+)\s*(?:\[[^\]]*\])?(?:\.\w+)*\s*=(?![=>])'
                   r'|(\w+)\.(?:push|set|clear|delete|add|splice|sort|unshift)\('
                   r'|Object\.assign\((\w+))')


def globals_of(src):
    """Module-level declarations - the state a function can reach from anywhere.

    `const` as well as `let`, which the first version left out while its docstring said otherwise:
    a const binding cannot be *reassigned*, and `failedRemovals` is a const Set whose `.add()`,
    `.delete()` and `.clear()` are writes to shared state like any other. Reported by an audit as a
    measured false negative, which is the only kind worth acting on."""
    names = set()
    for m in re.finditer(r'(?m)^(?:let|const)\s+([^;\n]+)', src):
        for part in m.group(1).split(','):
            n = part.strip().split('=')[0].strip()
            if re.fullmatch(r'\w+', n):
                names.add(n)
    return names


def functions(src):
    """Top-level function declarations, with the line they start on.

    A declaration that closes on its own line ends there. Without this the search for the next `}` in
    column zero runs straight past it and the function is credited with everything that follows -
    `ensurePerm` is one line long, and it was being reported as writing ten globals it never mentions.
    The same over-capture had just been found in `tests/slice.mjs`; a helper that reads code by
    scanning for a closing brace makes this mistake once per author."""
    for m in re.finditer(r'(?m)^(?:async\s+)?function\s+(\w+)\s*\(', src):
        line_end = src.find('\n', m.start())
        first = src[m.start():line_end if line_end > 0 else len(src)]
        if '{' in first and first.rstrip().endswith('}'):
            yield m.group(1), first, src[:m.start()].count('\n') + 1
            continue
        start = src.index('{', m.start())
        end = src.find('\n}', start)
        if end < 0:
            continue
        yield m.group(1), src[m.start():end], src[:m.start()].count('\n') + 1


def writes_in(code):
    """Every write to a name on this line, with whether its value comes from an `await`.

    Searched anywhere in the line and not only at its start: `try { healthData = await … }` is one
    statement wearing a brace, and matching at the start of the line missed it - the second of the
    three false negatives an audit measured against the first version of this file."""
    for m in WRITE.finditer(code):
        name = m.group(1) or m.group(2) or m.group(3)
        rest = code[m.end():]
        # `X = await f()` publishes *after* the await, so a guard written above it is not between
        # the two. The first version judged it by the state before the line and let it through.
        yield name, bool(re.match(r'\s*await\b', rest)), m.start()


def page_globals(rel):
    for files in PAGES.values():
        if rel in files:
            names = set()
            for f in files:
                with open(os.path.join(ROOT, f), encoding='utf-8') as fh:
                    names |= globals_of(fh.read())
            return names
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        return globals_of(fh.read())


def findings(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        src = fh.read()
    names = page_globals(rel)
    out = []
    for fname, body, at in functions(src):
        if 'await' not in body:
            continue
        lines = body.split('\n')
        seen_await = False
        since_guard = False      # a guard has been passed since the last await
        for i, line in enumerate(lines):
            code = re.sub(r'//.*$', '', line)
            for name, from_await, pos in writes_in(code):
                if name not in names:
                    continue
                # A guard earlier *on this line* counts, and one before the await on this line does
                # not. Without the position the check read the line as a unit and reported
                # `try { const x = await f(); if (!op.current()) return; g = x; }` as unguarded.
                before = code[:pos]
                last_await = before.rfind('await')
                guarded_here = bool(GUARD.search(before[last_await:] if last_await >= 0 else before))
                if guarded_here:
                    continue
                if from_await or (seen_await and not since_guard):
                    out.append((rel, fname, name, at + i, code.strip()[:70]))
            if GUARD.search(code):
                since_guard = True
            if re.search(r'\bawait\b', code):
                seen_await = True
                # A guard *after* the await on the same line still counts; one before it does not.
                tail = code.split('await', 1)[1]
                since_guard = bool(GUARD.search(tail))
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
