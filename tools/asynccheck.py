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
today with its reason, anything not in it fails, and **it should shrink; a run that grows it says so**
(«may only shrink» was stated here and in four other tools, and measured false in three of them:
growth is legitimate when the check starts seeing more). A new site is a
finding on the day it is written, which is the whole point - the cost of reading one is minutes, and
the cost of the review that would otherwise find it is a day.

    python3 tools/asynccheck.py            # report; exit 1 on anything not in the ledger
    python3 tools/asynccheck.py --accept   # record the current state as read
"""
import json
import os
import re
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ledger import delta as ledger_delta, count as ledger_count, keep_comments as ledger_keep  # noqa: E402

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
# Which files share a lexical scope with which - a `.then(fn)` in `ai.js` refers to a declaration in
# `sidepanel.js`, because classic scripts on one page share one scope.
PAGES_OF = {}
for _fs in PAGES.values():
    for _f in _fs:
        PAGES_OF.setdefault(_f, set()).update(_fs)

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


SCOPES = os.path.join(ROOT, 'tools', 'asyncscopes.txt')

# Every shape of async scope that is **not** a named function declaration, plus the other spelling of
# a yield. Each is a place control leaves a function and the workspace can change underneath, and
# each is a place `functions()` cannot enter - so a finding count from this tool is a statement about
# the declarations and nothing else.
#
# The way out is not a second parser. It is a **source convention**: every async scope the two
# extensions and the site ship is a named function declaration, and a callback is a reference to one.
# Then the reader this tool already has reaches all of it, and the widening this file has twice made
# wrong - 636 findings, then 171 - is not needed at all. It costs a name per callback and it makes
# the code easier to read from a stack trace, which is the second reason to want it.
#
# `tools/asyncscopes.txt` is the migration list, not a set of exemptions: it holds what is still
# written the old way, and **it goes to zero**. Anything not in it is a finding on the day it is
# written.
_SCOPE_SHAPES = (
    ('async arrow', re.compile(r'\basync\s*\([^()]*\)\s*=>')),
    ('async arrow', re.compile(r'\basync\s+\w+\s*=>')),
    ('anonymous async function', re.compile(r'\basync\s+function\s*\(')),
    # `(async function init() {…})()` is *named* and still unreadable: `functions()` matches a
    # declaration at the start of a line, and this one starts with a paren. Both options pages ran
    # their whole startup - seven awaits each - inside one, and nothing here counted it as missed.
    # Found while converting the shapes above, by reading what was left rather than by the tool.
    ('async IIFE', re.compile(r'\(\s*async\s+function\b')),
    ('async method', re.compile(r'(?m)^\s*async\s+\w+\s*\([^()]*\)\s*\{')),
    ('.then() callback', re.compile(r'\.then\s*\(')),
)
# `.then(fn)` where `fn` is a declaration on the same page is not a scope this tool misses: control
# leaves, and the continuation is something it reads. `.then(() => {…})` is. The distinction is the
# whole convention in one line - a callback is a *reference* to a named function - so it is derived
# from the page's own declarations rather than from a list of allowed names.
_THEN_REF = re.compile(r'\.then\s*\(\s*(\w+)\s*[,)]')


def _blank_non_code(src):
    """Comments and string contents blanked, positions preserved.

    A `.then(` inside a comment explaining why something is not a `.then(` is not a `.then(`, and
    both exist in this subject. Position-preserving so a line number stays a line number - the same
    thing `tests/slice.mjs` does on the Node side, and for the same reason.

    Three things in JavaScript look like a string and are not one, and each of them desynchronised
    this function until it was measured against the whole subject rather than reasoned about:

      * A **regular-expression literal** containing a quote. `/[&<>"']/g` in each options page opened
        a string at its `"` and closed it forty characters later, and every async arrow in between
        vanished - eleven of them in `apps/crm/options.js`, reported as a clean file. Which of `/`
        divides and which opens a literal is decided by what precedes, not by a list.
      * A **template literal's interpolation is code**, so a backtick inside it closes nothing:
        `` `a ${x ? `b` : `c`} d` `` has five backticks and one string. Read as flat, the third one
        opened a template that ran fifteen lines and swallowed nine comments and a handler.
      * A **nested template** inside that interpolation, which is the same problem one level down and
        is why this is a stack rather than a flag.

    A blanker fails silently by definition - what it eats stops being visible to anything, including
    to whoever reads its output looking for holes - so the case in `tests/tools_test.py` asserts on
    all three shapes rather than on the tree being clean today."""
    out, i, n = list(src), 0, len(src)
    prev = ''
    stack = []          # 'tpl' for a template whose interpolation we are inside

    def blank(a, b):
        for k in range(a, b):
            if src[k] != '\n':
                out[k] = ' '

    def is_regex():
        # After a value (`)`, `]`, a name, a number) a slash divides; after an operator, a comma, a
        # brace or nothing it opens a literal.
        return prev == '' or prev in '(,=:[!&|?{};+-*%~^<>'

    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] not in '/*' and is_regex():
            j, in_class = i + 1, False
            while j < n and src[j] != '\n':
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    break
                j += 1
            if j < n and src[j] == '/':
                blank(i + 1, j)
                prev, i = '/', j + 1
                continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
        elif c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
        elif c in '"\'':
            q, j = c, i + 1
            while j < n and src[j] != q:
                j += 2 if src[j] == '\\' else 1
            blank(i + 1, min(j, n))
            prev, i = q, j + 1
        elif c == '`':
            # The text is blanked; each `${…}` is left as code and pushed, so a backtick inside it
            # opens a *new* template rather than closing this one.
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '`':
                    break
                if src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    stack.append('tpl')
                    blank(i + 1, j)
                    prev, i = '{', j + 2
                    break
                j += 1
            else:
                j = n
            if i <= j and (j >= n or src[j] == '`'):
                blank(i + 1, min(j, n))
                prev, i = '`', j + 1
        elif c == '}' and stack:
            # Back into the template this interpolation belongs to.
            stack.pop()
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '`':
                    break
                if src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    stack.append('tpl')
                    blank(i + 1, j)
                    prev, i = '{', j + 2
                    break
                j += 1
            else:
                j = n
            if i <= j and (j >= n or src[j] == '`'):
                blank(i + 1, min(j, n))
                prev, i = '`', j + 1
        else:
            if not c.isspace():
                prev = c
            i += 1
    return ''.join(out)

def unread_scopes(rel):
    """Async scopes in one file that `functions()` cannot enter, with their line and shape.

    A named declaration is excluded by construction: none of the shapes above matches
    `async function name(`, because each requires what follows `async` to be a paren, an arrow
    parameter, `function (` or a method head. Measured on the subject rather than argued - the sweep
    in `tests/tools_test.py` asserts that no line of a converted file is reported."""
    with open(os.path.join(ROOT, rel), encoding='utf-8') as fh:
        src = fh.read()
    code = _blank_non_code(src)
    named = set()
    for f in (PAGES_OF.get(rel) or [rel]):
        with open(os.path.join(ROOT, f), encoding='utf-8') as fh:
            named |= {n for n, _, _ in functions(fh.read())}
    refs = {m.start() for m in _THEN_REF.finditer(code) if m.group(1) in named}
    out = []
    for shape, pat in _SCOPE_SHAPES:
        for m in pat.finditer(code):
            if shape == '.then() callback' and m.start() in refs:
                continue
            # `async function name(` reaches the method pattern through its own head. Excluded by
            # what precedes, not by a list of names.
            if shape == 'async method' and re.match(r'\s*async\s+function\b', m.group(0)):
                continue
            out.append((rel, code[:m.start()].count('\n') + 1, shape))
    return sorted(out)


def scope_findings():
    out = []
    for rel in FILES:
        out.extend(unread_scopes(rel))
    return out


def read_scopes():
    if not os.path.exists(SCOPES):
        return set()
    keep = set()
    for line in open(SCOPES, encoding='utf-8'):
        line = line.split('#')[0].strip()
        if line:
            keep.add(line)
    return keep


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

    scopes = scope_findings()
    # Keyed by «the Nth scope of this shape in this file», not by its line. A line number churns on
    # every edit above it, and a ledger that churns is one nobody reads - the finding «line no longer
    # matches» would arrive on changes that moved nothing. The count per shape is what has to not
    # grow, and the line is printed beside it so the reader can go there.
    scope_keys, scope_at, seen_shape = set(), {}, {}
    for rel, line, shape in scopes:
        n = seen_shape[(rel, shape)] = seen_shape.get((rel, shape), 0) + 1
        k = f'{rel}\t{shape}\t{n}'
        scope_keys.add(k)
        scope_at[k] = line
    known_scopes = read_scopes()

    if accept:
        _sbefore = ledger_count(SCOPES)
        sown = ['# Derived by tools/asynccheck.py - do not edit by hand; run it with --accept.',
                '# Async scopes that are not a named function declaration, and .then() callbacks.',
                '# This is a MIGRATION LIST and not a set of exemptions: every line is a place this',
                '# tool cannot enter, so its findings say nothing about what happens there. It goes',
                '# to zero. A line is removed by converting the scope to a named declaration and a',
                '# reference to it - never by widening what counts as read.']
        skept = ledger_keep(SCOPES, sown)
        with open(SCOPES, 'w', encoding='utf-8') as fh:
            for line in sown + skept:
                fh.write(line + '\n')
            for k in sorted(scope_keys, key=lambda k: (k.split('\t')[0], k.split('\t')[1],
                                                       int(k.split('\t')[2]))):
                fh.write(k + '\n')
        print(ledger_delta(f'asynccheck: {os.path.relpath(SCOPES, ROOT)}', _sbefore, ledger_count(SCOPES)))
        _before = ledger_count(LEDGER)
        own = ['# Derived by tools/asynccheck.py - do not edit by hand; run it with --accept.',
               '# Each line is a global written after an await with no check between the two.',
               '# Being here means somebody read it and decided it is safe. It should shrink;',
               '# when it grows, the run says so and the commit says which of the two reasons.']
        # Whatever anybody wrote in here that this tool did not. Nineteen such lines were in this
        # file - which entries are cache invalidations, why the options pages are recorded rather
        # than exempted, what the tool cannot see - and a regenerating `--accept` deleted the lot
        # without a word. Which is how it was found.
        kept = ledger_keep(LEDGER, own)
        with open(LEDGER, 'w', encoding='utf-8') as fh:
            for line in own + kept:
                fh.write(line + '\n')
            for k in sorted(keys):
                fh.write(k + '\n')
        print(ledger_delta(f'asynccheck: {os.path.relpath(LEDGER, ROOT)}', _before, ledger_count(LEDGER)))
        return 0

    new = sorted(k for k in keys if k not in known)
    gone = sorted(k for k in known if k not in keys)
    # The gate the convention needs. A scope written the old way tomorrow is a finding on the day it
    # is written; one already in the migration list is not, and the list shrinks as they are
    # converted. A line in the list that no longer matches is a finding too - it means the scope
    # moved, and a stale entry would exempt whatever now stands at that line.
    snew = sorted(k for k in scope_keys if k not in known_scopes)
    sgone = sorted(k for k in known_scopes if k not in scope_keys)
    for k in snew:
        rel, shape, _n = k.split('\t')
        print(f'  {rel}:{scope_at[k]}  {shape} - every async scope shipped here is a named function '
              f'declaration, because that is the only shape this tool can read')
    for k in sgone:
        print(f'  migration list entry no longer matches anything: {k.replace(chr(9), " · ")}'
              f' - a scope was converted; run --accept in the same change')
    for rel, fn, name, line, text in sorted(found):
        if f'{rel}\t{fn}\t{name}' in new:
            print(f'  {rel}:{line}  {fn}() writes `{name}` after an await with nothing asked in between')
            print(f'      {text}')
    for k in gone:
        print(f'  ledger line no longer matches anything: {k.replace(chr(9), " · ")}')
    n = len(new) + len(gone) + len(snew) + len(sgone)
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
    # This block was here twice, character for character, the second overwriting the first. Nothing
    # noticed, because the two answers were equal - which is what a duplicated computation looks like
    # right up until one copy is edited.
    #
    # And the number it printed was not what its sentence said. «942 await(s) read» counted every
    # `await` token in the subject *files*; the tool reads function *declarations*, so an `await`
    # inside an async IIFE or an `onclick = async () => {}` was counted as read and never looked at.
    # Measured: 960 in the files, 837 inside a scope this tool enters - so 123 were being reported as
    # read by nobody. `apps/*/graphview.js` is the whole of the diagram surface and 10 of its 12
    # awaits are in those two shapes, which is why «0 findings» there meant nothing at all.
    #
    # The rule is the one CLAUDE.md states and this tool already follows for functions: print what
    # was inspected, and derive the denominator by a cruder method than the check itself. A token
    # count is the cruder method. It is printed, not raised as a finding, for the reason the
    # docstring gives - widening to arrow bodies needs a parser, and this file has twice made that
    # widening wrong. What is refused is the silence.
    seen = unseen = thens = 0
    worst = {}
    for rel in FILES:
        src_ = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        thens += len(re.findall(r'\.then\s*\(', src_))
        total = len(re.findall(r'\bawait\s', src_))
        inside = sum(len(re.findall(r'\bawait\s', body)) for _, body, _ in functions(src_))
        seen += inside
        unseen += max(0, total - inside)
        if total - inside > 0:
            worst[rel] = total - inside
    print(f'asynccheck: {len(FILES)} file(s); {seen} await(s) inside a scope this reads, '
          f'{unseen} NOT read - an async IIFE or an `= async () => {{}}` is not a declaration. '
          f'{thens} .then() callback(s) NOT read - the same class, the other spelling.')
    for rel, k in sorted(worst.items(), key=lambda kv: -kv[1])[:5]:
        print(f'    unread: {rel}  {k} await(s) outside any declaration')

    print(f'    {len(scope_keys)} async scope(s) are not a named declaration and are on the '
          f'migration list in {os.path.relpath(SCOPES, ROOT)}; it goes to zero.')
    print(f'\n{n} finding(s). {read} function(s) read of {crude} declared '
          f'({crude - read} nested inside another, whose state is local); '
          f'{len(keys)} global write(s) after an await, {len(known)} recorded as read.')
    return 1 if n else 0


if __name__ == '__main__':
    sys.exit(main())
