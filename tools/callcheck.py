#!/usr/bin/env python3
"""tools/callcheck.py - a call to a function that does not exist, before the browser finds it.

    python3 tools/callcheck.py

`node --check` is happy with a free variable, `tests/slice.mjs` only lifts what a test names, and no
test runs a pull - so a call to a helper that is *not in the page* is invisible to everything this
repository owns until somebody clicks the thing. That happened: `pruneSql()` in the Analytics panel
walked the workspace with `walk()`, which exists in the CRM panel and has never existed here. The
line was written from the CRM side. Every Pull all threw `ReferenceError: walk is not defined`
**inside the try block that marks the mirror incomplete**, so a pull that had written every one of
its bytes correctly ended as «the last pull was interrupted mid-write - run Pull all to repair», and
the repair ran into the same wall. It is in Zoho Analytics 1.28.0 - the package Google was reviewing
when this was found, with the Store still serving 1.27.0, which does not contain it.

What it does: for each page in `apps/<app>/`, it reads the scripts that page loads, collects every
name those scripts declare, and reports every name they *call* that is neither declared there nor a
platform global. One page is one scope, which is what a browser does with classic scripts - so a
helper the CRM panel has and the Analytics panel does not is a finding here and nowhere else.

Its limits, said rather than left to be found:

  - It is **file-scoped, not block-scoped**: a name declared inside one function and called from
    another passes here. Widening that needs a parser, and a parser is a dependency this repository
    does not have.
  - It reads *calls*, `name(`, and nothing else. A free variable that is read rather than called -
    `if (someFlag)` - goes through.
  - The globals it knows are a list (`GLOBALS` below). A platform API nobody here has used yet is a
    false finding, and the fix is to add it in the same change, with the call site as the reason.

So it is a gate rather than a ledger: it reports zero on this tree, and anything it reports is either
a real defect or one line to add to the list.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Everything a shipped script may call without declaring it. Platform, not convenience: an entry
# here says «the browser provides this», and anything else has to be in the page.
GLOBALS = set("""
Array ArrayBuffer BigInt Boolean DataView Date Error EvalError Function Infinity Intl JSON Map Math
NaN Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError
TypeError URIError WeakMap WeakSet decodeURI decodeURIComponent encodeURI encodeURIComponent eval
isFinite isNaN parseFloat parseInt structuredClone globalThis undefined
Float32Array Float64Array Int8Array Int16Array Int32Array Uint8Array Uint8ClampedArray Uint16Array Uint32Array
AbortController Blob CSS ClipboardItem CustomEvent DOMException DOMParser Event File FileReader
FormData Headers Highlight Image IntersectionObserver KeyboardEvent MouseEvent MutationObserver
Node NodeFilter Notification OffscreenCanvas Path2D Range Request Response ResizeObserver TextDecoder
TextEncoder URL URLSearchParams XMLHttpRequest XMLSerializer Worker
alert atob btoa cancelAnimationFrame clearInterval clearTimeout close confirm fetch getComputedStyle
getSelection matchMedia open print prompt queueMicrotask requestAnimationFrame scrollTo setInterval
setTimeout
""".split())

# Words that are followed by `(` and are not calls.
KEYWORDS = set("""if for while switch catch return typeof new await async function class of in do
else try finally throw delete void yield instanceof case with import export let const var""".split())


def blank_literals(src: str) -> str:
    """Comments and string bodies replaced by spaces, one character for one, so lines and columns
    survive. The code inside a template's `${...}` is kept, because it is code - and it is where two
    of this repository's earlier text sweeps were blind."""
    out = list(src)
    n = len(src)

    def blank(a: int, b: int) -> None:
        for k in range(a, min(b, n)):
            if out[k] != '\n':
                out[k] = ' '

    def prev_significant(buf, at):
        """The last character before `at` that is not whitespace and not already blanked. `/` after a
        name or a closing bracket is division; after an operator or the start of a statement it opens
        a pattern. A keyword - `return /x/` - ends in a letter and reads as division here, which is
        the one shape this gets wrong and the one that costs nothing: a division is blanked as if it
        were a pattern only in the other direction."""
        k = at - 1
        while k >= 0 and buf[k] in ' \t':
            k -= 1
        return buf[k] if k >= 0 else '\n'

    # A stack of open template literals; each entry is the brace depth of code opened inside it.
    templates = []
    i = 0
    while i < n:
        c = src[i]
        if templates and templates[-1] is None:      # inside a template's text
            if c == '\\':
                blank(i, i + 2); i += 2; continue
            if c == '`':
                blank(i, i + 1); templates.pop(); i += 1; continue
            if src[i:i + 2] == '${':
                blank(i, i + 2); templates[-1] = 0; i += 2; continue
            blank(i, i + 1); i += 1; continue
        if c == '/' and src[i + 1:i + 2] == '/':
            j = src.find('\n', i)
            j = n if j < 0 else j
            blank(i, j); i = j; continue
        if c == '/' and src[i + 1:i + 2] == '*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            blank(i, j); i = j; continue
        # A regular expression literal, which has to be recognised or its contents are read as code:
        # `/'/` opens a string that then swallows everything up to the next apostrophe in the file.
        # That is not a hypothetical - it blanked 54% of the CRM panel on the first run of this tool,
        # and the tool reported 87 findings with a straight face. Told apart from division by what
        # comes *before* it, which is the only thing that distinguishes them in JavaScript.
        if c == '/' and prev_significant(out, i) in '(,=:[!&|?{};+-*%~^<>' + '\n':
            j = i + 1
            in_class = False
            while j < n:
                if src[j] == '\\':
                    j += 2; continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    j += 1; break
                elif src[j] == '\n':
                    break                              # an unterminated one is not a regex
                j += 1
            blank(i, j); i = j; continue
        if c in '"\'':
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == '\\' else 1
            blank(i, min(j + 1, n)); i = min(j + 1, n); continue
        if c == '`':
            blank(i, i + 1); templates.append(None); i += 1; continue
        if templates:
            if c == '{':
                templates[-1] += 1
            elif c == '}':
                if templates[-1] == 0:               # closes the ${...}, back into template text
                    blank(i, i + 1); templates[-1] = None; i += 1; continue
                templates[-1] -= 1
        i += 1
    return ''.join(out)


NAME = r'[A-Za-z_$][\w$]*'


def declared(code: str) -> set:
    """Every name this text binds. Generous on purpose: a false *declaration* costs a missed finding,
    a false *call* costs a wrong one, and only the second wastes somebody's afternoon."""
    names = set()
    names |= set(re.findall(r'\b(?:async\s+)?function\s*\*?\s*(' + NAME + r')', code))
    names |= set(re.findall(r'\bclass\s+(' + NAME + r')', code))
    names |= set(re.findall(r'\b(?:const|let|var)\s+(' + NAME + r')', code))
    names |= set(re.findall(r'\bwindow\.(' + NAME + r')\s*=', code))
    # Destructuring, in a declaration or a parameter list.
    for m in re.finditer(r'(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]', code):
        names |= set(re.findall(NAME, m.group(1)))
    # Parameters: of a function, of an arrow, of a catch.
    for m in re.finditer(r'(?:function\s*\*?\s*(?:' + NAME + r')?\s*|catch\s*)\(([^)]*)\)', code):
        names |= set(re.findall(NAME, m.group(1)))
    for m in re.finditer(r'\(([^()]*)\)\s*=>', code):
        names |= set(re.findall(NAME, m.group(1)))
    names |= set(re.findall(r'(?:^|[^\w$.])(' + NAME + r')\s*=>', code, re.M))
    # `name(a, b) {` - a method in an object literal or a class body.
    names |= set(re.findall(r'(?:^|[,{]\s*)(?:async\s+)?(' + NAME + r')\s*\([^()]*\)\s*\{', code, re.M))
    for m in re.finditer(r'for\s*(?:await\s*)?\(\s*(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]', code):
        names |= set(re.findall(NAME, m.group(1)))
    return names


def called(code: str) -> dict:
    """Name -> the line of its first call. `.foo(` is a method on something and never a free name."""
    out = {}
    for m in re.finditer(r'(?<![\w$.])(' + NAME + r')\s*\(', code):
        name = m.group(1)
        if name in KEYWORDS or name in out:
            continue
        out[name] = code.count('\n', 0, m.start()) + 1
    return out



def scopes(app_dir) -> list:
    """Every independent scope in an app, with the scripts that share it.

    Three kinds, and all three are derived: a page and its `<script src>`; the service worker, which
    is alone; and each content-script entry, whose `js` array shares one world per `world`+`matches`
    group. Named by where they come from, so a finding says which scope it is about."""
    out = []
    for page in sorted(app_dir.glob('*.html')):
        html = page.read_text(encoding='utf-8')
        out.append((page.name, [s for s in re.findall(r'<script[^>]+src="([^"]+)"', html) if s.endswith('.js')]))
    mf = app_dir / 'manifest.json'
    if mf.exists():
        data = json.loads(mf.read_text(encoding='utf-8'))
        sw = (data.get('background') or {}).get('service_worker')
        if sw:
            out.append(('manifest: background.service_worker', [sw]))
        for n, cs in enumerate(data.get('content_scripts') or [], 1):
            js = [j for j in (cs.get('js') or []) if j.endswith('.js')]
            if js:
                out.append((f"manifest: content_scripts[{n}] ({cs.get('world', 'ISOLATED')})", js))
    return out


def scan() -> list:
    findings = []
    pages = 0
    for app_dir in sorted((ROOT / 'apps').iterdir()):
        if not app_dir.is_dir():
            continue
        # A page is one scope; so is a service worker, and so is each content-script world. The first
        # version read only `<script src>` and therefore skipped the five scripts that run where
        # nobody is watching a console - both backgrounds and the three content scripts - which is
        # exactly where this tool's founding defect would be *worse*: a ReferenceError in a content
        # script lands in Zoho's own page console and nothing here would ever say so. Measured by a
        # review: 27 of 32 shipped scripts read. The manifest declares the other five, so the list is
        # still derived and a script added there tomorrow is covered without anyone remembering.
        for page, scripts in scopes(app_dir):
            if not scripts:
                continue
            pages += 1
            have, want = set(), {}
            for rel in scripts:
                path = app_dir / rel
                if not path.exists():
                    findings.append(f'{app_dir.name}/{page}: loads {rel}, which is not there')
                    continue
                code = blank_literals(path.read_text(encoding='utf-8'))
                have |= declared(code)
                for name, line in called(code).items():
                    want.setdefault(name, (rel, line))
            for name in sorted(want):
                if name in have or name in GLOBALS:
                    continue
                rel, line = want[name]
                findings.append(f'{app_dir.name}/{rel}:{line}: {name}() is called and is in no script '
                                f'{page} loads')
    return findings, pages


def main() -> int:
    findings, pages = scan()
    print(f'callcheck: {pages} page(s) across {len(list((ROOT / "apps").glob("*")))} apps')
    for f in findings:
        print('  ' + f)
    print()
    if findings:
        print(f'{len(findings)} finding(s). A call with nothing to call is a ReferenceError the '
              f'moment that line runs.')
        return 1
    print('0 findings. Every function a page calls is in the page.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
