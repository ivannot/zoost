#!/usr/bin/env python3
"""tools/deadcode.py - what the shipped code carries and no longer uses.

Run occasionally, not in the battery: this one reports *candidates*, and the difference matters. A
checker that runs on every commit has to be exact or it becomes noise nobody reads; this one is a
sweep you do now and then, read line by line, and act on with judgement.

It found, on the sweep that produced it: two functions and two constants in the CRM panel that
nothing called, a helper copied into the Analytics panel from its twin where there is nothing to
call it, two ids left in the markup by a rewrite, and twelve CSS rules of a toolbar removed months
earlier. All were real; none would have failed a test.

**Why Python and not grep.** The same sweep began with grep and was lied to: `apps/*/graphlogic.js`
carried one raw NUL byte, which makes a file binary to grep, which then skips it in silence - 31KB of
shipped code per product, invisible. The byte is gone and a case in `tests/tools_test.py` keeps it
gone, but the lesson is in this file's method: read the bytes yourself.

**What it cannot see, said plainly rather than left to be discovered.** A name built at run time -
`$('sc_' + area)`, `MSG.arrBadFile[reason]`, a class in a template literal - looks dead here and is
not. Every finding is checked by hand before it is acted on; the sweep that produced this file threw
away four "findings" of exactly that kind.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def strip_comments(s: str) -> str:
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'^\s*//.*$', '', s, flags=re.M)


def read(p: pathlib.Path) -> str:
    return p.read_bytes().decode("utf-8", "replace")


def sweep(app: str) -> list:
    d = ROOT / "apps" / app
    js_files = sorted(d.glob("*.js"))
    # The suite counts as a reader. A structural landmark can be held by a test and by nothing else -
    # `#focusg` names the focus group in both diagram windows, and a test asserts it is in the header
    # because that *is* the guarantee, not because any line of code looks it up. Sweeping without
    # this removes it, the suite goes red, and the sweep has cost more than it found.
    code = ("".join(strip_comments(read(p)) for p in js_files)
            + "".join(read(p) for p in (ROOT / "tests").glob("*.mjs"))
            + "".join(read(p) for p in (ROOT / "tests").glob("*.py")))
    markup = "".join(read(p) for p in d.glob("*.html"))
    out = []

    # 1. declarations nothing refers to. One hit is the declaration itself.
    for p in js_files:
        s = strip_comments(read(p))
        # **At the declaration's own indentation, not at column zero.** Both `content-bridge.js` files
        # wrap everything in an IIFE, so every declaration in them is indented by two - and this swept
        # 0 of their 54 functions while printing «34 shipped scripts swept». `asynccheck` learnt exactly
        # this, on exactly those two files, and the sibling walk did not reach here.
        for kind, pat in (("function", r'^[ \t]*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)'),
                          ("const", r'^[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=')):
            for name in sorted(set(re.findall(pat, s, re.M))):
                seen = len(re.findall(r'(?<![\w$.])' + re.escape(name) + r'(?![\w$])', code))
                if seen <= 1 and name not in markup:
                    out.append(f"{app}/{p.name}: {kind} {name} - declared, referred to nowhere")

    # 2. messages nothing says
    for p in js_files:
        s = read(p)
        m = re.search(r'const MSG = \{(.*?)\n\};', s, re.S)
        if not m:
            continue
        for key in re.findall(r'^  ([A-Za-z_$][\w$]*)\s*:', m.group(1), re.M):
            if not re.search(r'MSG\.' + re.escape(key) + r'\b', code):
                out.append(f"{app}/{p.name}: MSG.{key} - written, never said")

    # 3. rules for classes that appear nowhere at all, and ids nothing reaches for
    for page in sorted(d.glob("*.html")):
        html = read(page)
        if "</style>" not in html:
            continue
        css, rest = html.split("</style>", 1)
        hay = rest + code
        for cls in sorted(set(re.findall(r'\.([a-zA-Z][\w-]*)(?=[\s,:{.\[>+~])', css))):
            if not re.search(r'(?<![\w-])' + re.escape(cls) + r'(?![\w-])', hay):
                out.append(f"{app}/{page.name}: .{cls} - styled, never applied")
        for i in sorted(set(re.findall(r'\sid="([\w-]+)"', rest))):
            # The three ways an id is reached without its name ever appearing whole, all of them met
            # on the sweep that wrote this file - and each one produced a "finding" that was not one:
            #   `url(#erarrow)`      an SVG marker or filter, referred to from CSS or an attribute
            #   `$('sc_' + area)`    a name composed at run time from a prefix
            #   `'#ai'`              a fragment, handed to the settings page as a URL
            prefix = i.rsplit("_", 1)[0] + "_" if "_" in i else None
            reached = (f"'{i}'" in code or f'"{i}"' in code or f"#{i}" in html
                       or f'for="{i}"' in html or f'href="#{i}"' in html
                       or f"url(#{i})" in html or f"url(#{i})" in code
                       or f"'#{i}'" in code or f'"#{i}"' in code
                       or (prefix and (f"'{prefix}' +" in code or f"`{prefix}${{" in code)))
            if not reached:
                out.append(f"{app}/{page.name}: id={i} - in the markup, reached by nothing")
    return out


def main() -> int:
    findings = sweep("crm") + sweep("analytics")
    print(f"deadcode: {len(list((ROOT / 'apps').rglob('*.js')))} shipped scripts swept")
    for f in findings:
        print("  " + f)
    print()
    print(f"{len(findings)} candidate(s). Each is a candidate, never a verdict: check for a name "
          f"built at run time before removing anything." if findings else
          "0 candidates. Nothing declared, styled or marked up is going unused.")
    # Always 0: this is a sweep to read, not a gate to pass. A tool that stopped a commit over a
    # candidate would teach people to skip it.
    return 0


if __name__ == "__main__":
    sys.exit(main())
