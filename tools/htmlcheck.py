#!/usr/bin/env python3
"""
htmlcheck.py — a value going into an HTML attribute must be attribute-escaped.

The trap this enforces is already written up in CLAUDE.md and it still shipped: `esc()` / `escHtml()`
escape `& < >` and **not quotes**, so a quote inside an attribute closes it early. That is what cut
the getRelatedRecords snippet in half, and it is what an outside review found again — several
`title="${esc(...)}"` carrying names that come from Zoho, plus two carrying an API error message with
no escaping at all.

The consequence is narrow and real. MV3's default policy blocks inline scripts and inline handlers,
so this is not code execution. What is left is markup injection into a panel that holds an API key:
a broken or spoofed interface, and an `<img src="https://…">` that makes a request the moment it is
rendered. It takes someone able to name an object inside the Zoho org — not a stranger, but not
nobody either.

What is checked: every `attr="${…}"` inside a template literal. The interpolation must go through
`escA` (or be plainly safe — a number, a literal, a comparison). Element *content* is not checked
here: `escHtml` is correct there, the shapes are far more varied, and a checker that guesses at
content would cry wolf until nobody read it. That limit is stated rather than hidden.

    python3 tools/htmlcheck.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = sorted(p for p in (ROOT / 'apps').rglob('*.js'))

ATTR_SAFE = re.compile(r'\bescA\s*\(')

# A value is safe only if it demonstrably cannot contain a quote: a number, a quoted literal, a
# boolean, or an expression that renders one. Everything else is reported.
#
# The first version of this also carried a list of identifiers "known to be ours" — and that list
# did exactly what such lists always do here: it let `n.name` through, which is a name straight out
# of Zoho and the whole reason the check exists, while reporting the number 42. An allow-list of
# names is a checklist wearing a script's clothes; the criterion has to be a property of the value.
LITERAL = re.compile(r"""^\s*(
    -?\d+(\.\d+)?
  | true | false | null | undefined
  | '[^'\\]*' | "[^"\\]*"
)\s*$""", re.X)

COMPARISON = re.compile(r'^[^\'"]*\s(===|!==|==|!=|<=|>=|<|>)\s[^\'"]*$')

# A ternary whose *both* branches are literals renders a literal.
TERNARY_OF_LITERALS = re.compile(r"""^[^?]*\?\s*(['"][^'"]*['"])\s*:\s*(['"][^'"]*['"])\s*$""")


def interpolations(tpl: str):
    """The `${…}` expressions of a template literal, with nesting handled."""
    out, i = [], 0
    while i < len(tpl) - 1:
        if tpl[i] == '$' and tpl[i + 1] == '{':
            depth, i, cur = 1, i + 2, ''
            while i < len(tpl) and depth:
                c = tpl[i]
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if not depth:
                        break
                cur += c
                i += 1
            out.append(cur)
        i += 1
    return out


def suspect(expr: str) -> bool:
    e = ' '.join(expr.split())
    if ATTR_SAFE.search(e):
        return False
    return not (LITERAL.match(e) or COMPARISON.match(e) or TERNARY_OF_LITERALS.match(e))


# Element *content* is deliberately not checked here, and that is a conclusion rather than an
# omission. It was audited once, by hand, across all 379 content interpolations in the shipped
# scripts: 378 were numbers, our own literals, or markup this code had just built and whose own slots
# this pass already checks. One was real — a Zoho namespace rendered raw as a group header in the
# functions tree — and it is fixed and covered by a test.
#
# A general content checker was written to keep that finding from recurring, and then thrown away:
# even after inferring escaper aliases, HTML-typed variables and accumulator patterns from each file,
# it produced 87 false positives for that 1 real finding. A checker with that ratio is one nobody
# reads, which is worse than none — and the honest reason it cannot do better is that "this string is
# already markup" is a fact about intent, not about syntax. Do not rebuild it without a new idea.

# ---------------------------------------------------------------------------------------------------
# An author `display` beats `hidden`.
# ---------------------------------------------------------------------------------------------------

HIDDEN_EL = re.compile(r'<(\w+)([^>]*\bhidden\b[^>]*)>')
STYLE_BLOCK = re.compile(r'<style>(.*?)</style>', re.S)


def display_override(path) -> list:
    """`hidden` is a UA rule, and any author `display` outranks it — so the element stays on screen.

    Nothing fails: no console error, no layout break, just a row that is always there. It shipped
    twice in a single change — the passphrase row in Settings and the unlock row in the panel, both
    permanently visible, both reported by the user rather than by a check.

    The fix is one rule per page (`[hidden]{display:none!important}`), so what this looks for is not
    "which element got it wrong" but "does this page carry the rule at all". That is deliberate: a
    per-element check would go quiet the moment someone adds a `display` to a class that did not have
    one, which is exactly how it happened.
    """
    src = path.read_text(encoding='utf-8')
    if not HIDDEN_EL.search(src):
        return []
    css = ' '.join(m.group(1) for m in STYLE_BLOCK.finditer(src))
    if re.search(r'\[hidden\]\s*\{[^}]*display\s*:\s*none', css):
        return []
    return [f'{path.name}: uses the hidden attribute but never states [hidden]{{display:none}} — '
            f'any author display rule leaves the element on screen']


TAG = re.compile(r'<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)+)\s*/?>')
ATTR_NAME = re.compile(r'\s([\w-]+)=')


def duplicate_attributes(path) -> list:
    """The same attribute twice on one element: the second is dropped, silently.

    Nothing errors, nothing looks wrong in the source, and the attribute you meant to add is simply
    not there. It happened while replacing a button's label with a mark — `class="lbtn"` stayed and
    `class="lbtn icon"` was appended, so the icon padding never applied. Cheap to check, exact, and no
    false positives: HTML has no case where repeating an attribute means anything.
    """
    out = []
    src = path.read_text(encoding='utf-8')
    for m in TAG.finditer(src):
        attrs = ATTR_NAME.findall(m.group(2))
        dup = sorted({a for a in attrs if attrs.count(a) > 1})
        if dup:
            line = src[:m.start()].count('\n') + 1
            out.append(f'{path.name}:{line}: <{m.group(1)}> repeats {", ".join(dup)} — '
                       f'the second one is discarded by the parser')
    return out


def main() -> int:
    findings = []
    for path in FILES:
        src = re.sub(r'^\s*//.*$', '', path.read_text(encoding='utf-8'), flags=re.M)
        for m in re.finditer(r'(\w[\w-]*)="\$\{([^}]*(?:\{[^}]*\}[^}]*)*)\}"', src):
            attr, expr = m.group(1), m.group(2)
            if suspect(expr):
                line = src[:m.start()].count('\n') + 1
                rel = path.relative_to(ROOT)
                findings.append(f'{rel}:{line}: {attr}="${{{" ".join(expr.split())[:60]}}}" is not attribute-escaped')

    pages = sorted(p for p in (ROOT / 'apps').rglob('*.html'))
    for path in pages:
        findings += [f'{path.relative_to(ROOT).parent}/{f}' for f in display_override(path)]
        findings += [f'{path.relative_to(ROOT).parent}/{f}' for f in duplicate_attributes(path)]

    print(f'htmlcheck: {len(FILES)} shipped scripts, {len(pages)} pages')
    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). Markup that does not do what it looks like it does.'
          if findings else
          '0 findings. Attributes are escaped, and hidden hides.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
