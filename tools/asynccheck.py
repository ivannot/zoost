#!/usr/bin/env python3
"""Every global written after an `await`, and whether anything asked first.

Six external reviews in one day found the same defect six times, in six different functions: a
value read from Zoho or from disk, an `await`, and then a write into a module-level variable - by
which time the workspace on screen may be another one. Each was fixed where it was found, and the
next review found the next instance. That is the shape of a rule that lives only as prose: it is
recalled by resemblance to its own wording, and the seventh instance never resembles it.

Its subject is every script the two extensions load - pages, service workers, content-script worlds -
**and the three the site serves**, which were outside it entirely while `site/_worker.js` alone held
23 awaits. Nothing there was wrong; «there is nothing there» and «nobody looked» are the two answers
this file exists to keep apart, and only one of them was true.

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
  * **It reads one spelling of a yield.** `await` is where control leaves a function; `.then(cb)` is
    the same thing written differently, and those callbacks are not read. The run prints how many it
    skipped rather than leaving the count to be discovered - measured today: 43 across the subject,
    4 of which write a module global, none of them wrong. A conclusion somebody reached, said out
    loud, instead of a zero that reads as though the tool had reached it.

It is therefore a ledger, like `tools/cssdupes.txt`: `tools/asyncglobals.txt` holds what is there
today with its reason, anything not in it fails, and **the ledger may only shrink**. A new site is a
finding on the day it is written, which is the whole point - the cost of reading one is minutes, and
the cost of the review that would otherwise find it is a day.

    python3 tools/asynccheck.py            # report; exit 1 on anything not in the ledger
    python3 tools/asynccheck.py --accept   # record the current state as read
"""
import json
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
# Derived from each page's own <script> tags: the HTML is what Chrome loads, so a slice added there
# tomorrow enters this check without anyone remembering a list. The shared libraries are excluded -
# they have their own tests and no per-workspace globals of the panels' kind.
_LIB = re.compile(r'(sample-org|idb|keyvault|product-help|highlight|graph-core|tabs)\.js$')


def _scripts_of(app, page):
    with open(os.path.join(ROOT, 'apps', app, page), encoding='utf-8') as src:
        html = src.read()
    return [f'apps/{app}/{m}' for m in re.findall(r'<script\s+src="([^"]+\.js)"></script>', html)
            if not _LIB.search(m)]


def _manifest_scopes(app):
    """The scopes no page declares: the service worker, and each content-script world.

    They were outside this check entirely - `sidepanel.html` was the whole of its subject, which is
    **9 of the 32 shipped scripts**, while the comment said only that the shared libraries were
    excluded. Measured by a review. A background script and a content script have globals and awaits
    like anything else, and the one place a stale write there would show is a console nobody watches.
    """
    out = {}
    with open(os.path.join(ROOT, 'apps', app, 'manifest.json'), encoding='utf-8') as fh:
        data = json.load(fh)
    sw = (data.get('background') or {}).get('service_worker')
    if sw:
        out[f'{app}:background'] = [f'apps/{app}/{sw}']
    for n, cs in enumerate(data.get('content_scripts') or [], 1):
        js = [f'apps/{app}/{j}' for j in (cs.get('js') or []) if j.endswith('.js')]
        if js:
            out[f'{app}:content[{n}]'] = js
    return out


# What the site serves. Outside the subject entirely until now, and nothing said so: the headline
# «790 function(s) read of 792 declared» is a statement about the extensions, and read as one about
# the tree. `site/_worker.js` alone holds 23 awaits. It has no module-level mutable state today, so
# there was nothing to find - but «there is nothing there» and «nobody looked» are the two answers
# this whole file exists to keep apart, and only one of them was true.
#
# One scope each: three separate runtimes that share no lexical scope with anything.
_SITE = ('site/_worker.js', 'site/site.js', 'site/report.js')


def _pages():
    out = {}
    for f in _SITE:
        out[f'site:{os.path.basename(f)}'] = [f]
    for app in ('crm', 'analytics'):
        for page in sorted(os.listdir(os.path.join(ROOT, 'apps', app))):
            if page.endswith('.html'):
                files = _scripts_of(app, page)
                if files:
                    out[f'{app}:{page}'] = files
        out.update(_manifest_scopes(app))
    return out


PAGES = _pages()
FILES = sorted({f for fs in PAGES.values() for f in fs})

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


def _iife(src):
    """True when the whole file is wrapped in an immediately-invoked function.

    The **first statement**, not any line that happens to begin with `(`. The loose version matched a
    continuation line in the middle of `sidepanel.js`, decided the file was wrapped, looked for
    functions at indentation two and found **none** - taking the tool from 79 sites to 30 while
    reporting nothing wrong. A detector has to be measured on every file it will meet, which is what
    the sweep in `tests/tools_test.py` now does.
    """
    code = re.sub(r'/\*[\s\S]*?\*/', '', src)
    for line in code.split('\n'):
        t = line.strip()
        if not t or t.startswith('//'):
            continue
        return bool(re.match(r'\(\s*(?:async\s+)?(?:function\b|\()', t))
    return False


def globals_of(src):
    """Module-level declarations - the state a function can reach from anywhere.

    `const` as well as `let`, which the first version left out while its docstring said otherwise:
    a const binding cannot be *reassigned*, and `failedRemovals` is a const Set whose `.add()`,
    `.delete()` and `.clear()` are writes to shared state like any other. Reported by an audit as a
    measured false negative, which is the only kind worth acting on."""
    # The IIFE's own top level counts too. Both content bridges wrap everything in one, so their
    # state is declared at indentation two and this found **none of it** - which, with `functions()`
    # reading nothing there either, is why «20 files» meant 18. A declaration one level inside an
    # IIFE is shared by every function in that file, which is exactly what this is about.
    #
    # Only where the file *is* an IIFE. Allowing two spaces everywhere read every `const x = await …`
    # inside a function body of the ordinary files as module state - 636 findings, all of them
    # nonsense, which is a widening that had to be measured rather than reasoned about.
    #
    # The limit that remains, stated: inside an IIFE a declaration nested deeper than its body is a
    # local and this would still call it a global. Two spaces is what both bridges use.
    depth = 2 if _iife(src) else 0
    names = set()
    for m in re.finditer(r'(?m)^[ \t]{0,%d}(?:let|const)\s+([^;\n]+)' % depth, src):
        for part in m.group(1).split(','):
            n = part.strip().split('=')[0].strip()
            if re.fullmatch(r'\w+', n):
                names.add(n)
    return names


def functions(src):
    """Top-level function declarations, with the line they start on.

    **Declarations only, and that is a limit rather than a definition of the subject.** An
    `async (…) => {…}` body is invisible here, and one of them matters: the `chrome.storage.onChanged`
    handler in both panels rewrites the working-folder handle after an await. Widening the pattern to
    arrows was tried and reverted in the same hour: an arrow has no closing brace in column zero, so
    the body slice ran on into the declarations below it and the tool reported `hasPerm()` writing
    caches it never mentions - the over-capture this docstring already warns about, made by the person
    reading the warning. It needs a parser, and a parser is a dependency this repository does not have.
    Said here rather than left as a silence; the sites it cannot see are listed in the ledger's header.

    A declaration that closes on its own line ends there. Without this the search for the next `}` in
    column zero runs straight past it and the function is credited with everything that follows -
    `ensurePerm` is one line long, and it was being reported as writing ten globals it never mentions.
    The same over-capture had just been found in `tests/slice.mjs`; a helper that reads code by
    scanning for a closing brace makes this mistake once per author."""
    # At the declaration's own indentation, not at column zero. Both `content-bridge.js` files wrap
    # everything in an IIFE, so every function in them is indented by two - and this yielded **nothing
    # at all** for either: 0 of 32 and 0 of 19, over 42 awaits, in the two files that do the
    # authenticated fetching. The headline said «20 files» and the ledger's header said the content
    # scripts «were read before being recorded». They were opened. `tests/slice.mjs` learnt exactly
    # this, on this exact file, and this tool did not.
    # The file's own top level, which is column zero normally and the IIFE's body where there is one -
    # the same notion `globals_of` uses, and for the same reason. «Any indentation» was the first
    # attempt and it scanned *nested* functions too, whose locals then collided by name with the
    # module state: 171 findings, none of them real. A widening has to be measured.
    wrapped = _iife(src)
    top = r'^[ \t]{2}' if wrapped else r'^'
    for m in re.finditer(r'(?m)' + top + r'((?:async\s+)?)function\s+(\w+)\s*\(', src):
        pad = '  ' if wrapped else ''
        name = m.group(2)
        at = m.start() + len(pad)
        line_end = src.find('\n', at)
        first = src[at:line_end if line_end > 0 else len(src)]
        # A trailing comment does not stop a declaration closing on its own line. `aiOpenSettings`
        # is `function aiOpenSettings() { openSettings('#ai'); }   // …` and was read as an open
        # function running to the next brace at its indentation. `sliceConst` recorded this trap.
        first = re.sub(r'//.*$', '', first)
        if '{' in first and first.rstrip().endswith('}'):
            yield name, first, src[:at].count('\n') + 1
            continue
        start = src.index('{', at)
        end = src.find('\n' + pad + '}', start)
        if end < 0:
            continue
        yield name, src[at:end], src[:at].count('\n') + 1
    return
    for m in re.finditer(r'(?m)^([ \t]*)(?:async\s+)?function\s+(\w+)\s*\(', src):
        pad, name = m.group(1), m.group(2)
        at = m.start() + len(pad)
        line_end = src.find('\n', at)
        first = src[at:line_end if line_end > 0 else len(src)]
        if '{' in first and first.rstrip().endswith('}'):
            yield name, first, src[:at].count('\n') + 1
            continue
        start = src.index('{', at)
        end = src.find('\n' + pad + '}', start)
        if end < 0:
            continue
        yield name, src[at:end], src[:at].count('\n') + 1


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
            # A line that *declares* the guard is not a line that passes it. `const current = () =>
            # gen === wsGen` matched GUARD twice over and set the sticky flag for everything below,
            # which is how an unguarded publication in `rebuildModules` stayed invisible: the flag had
            # been set by the declaration two lines above it. Found by a review.
            if GUARD.search(code) and not re.search(r'\b(?:const|let|var)\s+(?:current|sameWs)\s*=', code):
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
    read = 0
    for rel in FILES:
        found.extend(findings(rel))
        read += len(list(functions(open(os.path.join(ROOT, rel), encoding='utf-8').read())))
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
    # The denominator, which this tool printed for nobody: how much of its own subject it read. It
    # said «20 files» and read 0 of the 32 functions in one content bridge and 0 of the 19 in the
    # other - the two files that do the authenticated fetching - because both are wrapped in an IIFE
    # and this looked for declarations at column zero. `tests/slice.mjs` learnt that on this exact
    # file. The rule CLAUDE.md states for anything that inspects a tree: print the count of things
    # inspected, and derive the denominator by a cruder method than the check itself.
    crude = sum(len(re.findall(r'(?m)^[ \t]*(?:async\s+)?function\s+\w+\s*\(',
                               open(os.path.join(ROOT, rel), encoding='utf-8').read()))
                for rel in FILES)
    # The two it does not read are `setFolded` in each graph window: declared inside another
    # function, so its state is a local and not the shared state this tool is about. Said here
    # because a gap of two that nobody can account for reads the same as a gap of two that somebody
    # can, and only one of them is a limit rather than a hole.
    # And a second, cruder scan on the *other* axis, because the one above counts functions and says
    # nothing about how much of each one this reads. A yield is where control leaves and the workspace
    # can change underneath - `await` is one spelling of it and `.then(cb)` is the other, and only the
    # first is read. Counting them separately is what makes the gap visible instead of arguable:
    # measured, 33 `.then(` callbacks in the subject, 4 of which write a module global. None of the
    # four is wrong today - a pump's own bookkeeping, a display-only copy read once at startup - but
    # «none of them is wrong» is a conclusion somebody reached, and «zero findings» was reading as
    # though the tool had reached it.
    #
    # Not widened here, and the reason is measured too: `.then(` bodies are brace-matched rather than
    # line-bound, so reading them means a second traversal with different rules, and a widening this
    # file has twice made wrong (636 findings, then 171) is not one to make in passing. What is
    # refused is the *silence*, which cost nothing to fix.
    yields = {'await': 0, '.then(': 0}
    for rel in FILES:
        src_ = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        yields['await'] += len(re.findall(r'\bawait\s', src_))
        yields['.then('] += len(re.findall(r'\.then\s*\(', src_))

    yields = {'await': 0, '.then(': 0}
    for rel in FILES:
        src_ = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        yields['await'] += len(re.findall(r'\bawait\s', src_))
        yields['.then('] += len(re.findall(r'\.then\s*\(', src_))
    print(f'asynccheck: {len(FILES)} file(s); {yields["await"]} await(s) read, '
          f'{yields[".then("]} .then() callback(s) NOT read - the same class, the other spelling.')

    print(f'\n{n} finding(s). {read} function(s) read of {crude} declared '
          f'({crude - read} nested inside another, whose state is local); '
          f'{len(keys)} global write(s) after an await, {len(known)} recorded as read.')
    return 1 if n else 0


if __name__ == '__main__':
    sys.exit(main())
