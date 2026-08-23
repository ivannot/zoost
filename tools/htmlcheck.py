#!/usr/bin/env python3
"""
htmlcheck.py — a value going into an HTML attribute must be attribute-escaped.

The trap this enforces is already written up in CLAUDE.md and it still shipped: `esc()` / `escHtml()`
escape `& < >` and **not quotes**, so a quote inside an attribute closes it early. That is what cut
the getRelatedRecords snippet in half, and it is what an outside review found again — several
`title="${esc(...)}"` carrying names that come from Zoho, plus two carrying an API error message with
no escaping at all.

The consequence is narrow and real **in the panel**. MV3's default policy blocks inline scripts and
inline handlers there, so this is not code execution. What is left is markup injection into a panel
that holds an API key: a broken or spoofed interface, and an `<img src="https://…">` that makes a
request the moment it is rendered. It takes someone able to name an object inside the Zoho org — not a
stranger, but not nobody either.

**That reasoning does not cover the exported report**, and saying it did was the defect the last two
days keep producing: a limit whose *reason* describes less ground than the limit claims.
`apps/crm/export.js` writes a standalone document opened from `file://`, with no content-security
policy and an inline `<script>` of its own - so in that file, markup injection would be code execution.
An outside review read all 158 content interpolations in that file and found them clean: helpers that
escape in turn, numbers, markup this code had just built, and the Deluge source through `hl()`, which
tokenises and escapes every piece. So there is nothing to fix, and the sentence above is now true of
the thing it is about rather than of everything.

What is checked: every `attr="${…}"` inside a template literal. The interpolation must go through
`escA` (or be plainly safe — a number, a literal, a comparison). Element *content* is not checked
here: `escHtml` is correct there, the shapes are far more varied, and a checker that guesses at
content would cry wolf until nobody read it. That limit is stated rather than hidden.

    python3 tools/htmlcheck.py
"""
import hashlib
import re
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ledger import delta as ledger_delta, count as ledger_count  # noqa: E402
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = sorted(p for p in (ROOT / 'apps').rglob('*.js'))

# `escQ` is the second of the two, for a value that has already been through `escHtml`: it encodes
# the delimiters and nothing else, because encoding `&` twice is its own defect.
ATTR_SAFE = re.compile(r'\b(escA|escQ)\s*\(')

# ...and the name is not the property. This file's own docstring throws away a list of identifiers
# «known to be ours» on the grounds that **an allow-list of names is a checklist wearing a script's
# clothes; the criterion has to be a property of the value** - and `ATTR_SAFE` was that same list one
# level up: not the names of values, but the names of escapers. The counter-example was already in the
# tree. Seven `escA` are defined across the shipped scripts; six encode `& < > " '` and the seventh,
# in `apps/crm/highlight.js`, encoded `&`, `"` and `<` and left `'` and `>` alone. It was harmless
# where it stood - four attributes, all double-quoted - which is a property of those call sites and
# not of the function, and the checker approved every one of them by name without ever reading the
# body. Raised by an outside review.
#
# So the name is now a pointer to a definition, and the definition has to hold. What an attribute
# escaper must encode is **both delimiters**: a value that meets `'` and passes through is unsafe the
# day a single-quoted attribute is written, and nothing here would have said so.
ESCAPER_DEF = re.compile(r'\b(?:const|let|var|function)\s+(escA|escQ)\s*=?\s*(?:\([^)]*\)|[\w$]+)\s*(?:=>)?'
                         r'(?P<body>[^\n]*)')
# What it *emits*, not what characters appear in it. The first version of this looked for `"` and `'`
# in the body and every escaper passed - including the weak one - because both characters are there as
# the delimiters of its own string literals. A property has to be read off the output, and an
# attribute escaper's output is the entity: `&quot;` for one delimiter, `&#39;` (or `&apos;`, or the
# hex form) for the other.
DELIMITERS = {'a double quote': (r'&quot;', r'&#34'), 'an apostrophe': (r'&#39', r'&apos;', r'&#x27')}


def weak_escapers() -> list:
    """Every escaper the safety criterion trusts whose body cannot emit both delimiter entities.

    One line each, because that is how all seven in this tree are written. A multi-line one is
    reported as weak rather than skipped: that direction fails safe - it asks to be looked at."""
    out = []
    for path in FILES:
        src = path.read_text(encoding='utf-8')
        for m in ESCAPER_DEF.finditer(src):
            body = m.group('body')
            missing = [name for name, forms in DELIMITERS.items() if not any(f in body for f in forms)]
            if missing:
                line = src[:m.start()].count('\n') + 1
                # `relative_to` throws for a path outside the tree, which is only ever a test - and
                # a tool that dies while reporting is a poor way to learn that.
                where = path.relative_to(ROOT) if str(path).startswith(str(ROOT)) else path.name
                out.append(f'{where}:{line}: {m.group(1)} never emits '
                           f'{" or ".join(missing)} - the checker trusts this name in every attribute '
                           f'in the tree, and here it is a weaker escaper than the name promises')
    return out

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

    It covers the site as well as the panels, because the third time was there: `.btn` is
    `display:inline-block`, so the Analytics page's install button and its "in review" alternative
    were **both** on screen on the live site, whichever one site.js had just hidden. The check had
    read only inline <style>, which for a page that links a stylesheet is most of its CSS missing —
    so any linked sheet is read too.
    """
    src = path.read_text(encoding='utf-8')
    if not HIDDEN_EL.search(src):
        return []
    css = ' '.join(m.group(1) for m in STYLE_BLOCK.finditer(src))
    for href in re.findall(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"', src):
        # `?v=<digest>` is a cache-busting token, not part of the path: with it left on, the sheet
        # was never found and this went quiet about every page that links one - which is the whole
        # site, and the reason this check was widened in the first place.
        href = href.split('?', 1)[0]
        sheet = (ROOT / 'site' / href.lstrip('/')) if href.startswith('/') else (path.parent / href)
        if sheet.is_file():
            css += ' ' + sheet.read_text(encoding='utf-8')
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


def divs_are_closed(path) -> list:
    """A `<div>` that is never closed, which no browser will tell you about.

    It happened while moving a view into a panel: the new block's `</div>` was consumed by the edit,
    every element after it became its child, and because that block is `display:none` until it is
    opened, *half the panel had zero size* - laid out, present in the DOM, invisible. Nothing threw
    and the page scored a perfect run of every other check here.

    Counted rather than parsed, and only for `div`, which is what these panels are built from: the
    tag cannot be self-closing and is never implicitly closed, so open != close is always a defect
    and never a style. Comments and script bodies are removed first, or a `</div>` inside a template
    literal would be counted as markup - which is exactly what the panels' own render functions are
    full of.
    """
    src = path.read_text(encoding='utf-8')
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'<script\b.*?</script>', '', src, flags=re.S | re.I)
    opened = len(re.findall(r'<div\b', src, re.I))
    closed = len(re.findall(r'</div\s*>', src, re.I))
    if opened == closed:
        return []
    which = 'never closed' if opened > closed else 'closed too many times'
    return [f'{path.name}: {abs(opened - closed)} <div> {which} '
            f'({opened} opened, {closed} closed) - everything after it is inside something else']


def notes_belong_to_a_control(findings: list) -> None:
    """On a settings page, an explanation lives inside the block of the control it explains.

    Twice now a `<p class="note">` has ended up under the wrong control, because something was
    inserted between the input and the sentence about it - invisible in the markup, obvious on
    screen, and reported by the author both times. The fix is structural rather than careful: the
    pair lives in one `.ctl`, so anything added lands before or after it and never through it.

    `.sub` is exempt: it explains a whole section and sits under its heading by design.
    """
    for page in sorted(ROOT.glob('apps/*/options.html')):
        html = page.read_text(encoding='utf-8')
        rel = page.relative_to(ROOT)
        for m in re.finditer(r'<p class="note"[^>]*>', html):
            before = html[:m.start()]
            # the note is fine if the nearest unclosed block is a .ctl
            opens = [x.start() for x in re.finditer(r'<div class="ctl">', before)]
            if not opens:
                findings.append(f'{rel}: a note at line {before.count(chr(10)) + 1} is not inside a '
                                f'.ctl block, so whatever is inserted above it can steal it')
                continue
            # Depth, not a count of closing tags: a `.ctl` may contain a div of its own - the folder
            # warning is one - and the first version read that block's own `</div>` as the end of the
            # `.ctl`. A checker that reports correct markup is a checker that gets switched off.
            tail = before[opens[-1]:]
            depth = tail.count('<div') - tail.count('</div>')
            if depth <= 0:
                findings.append(f'{rel}: the note at line {before.count(chr(10)) + 1} sits outside the '
                                f'.ctl it should belong to - a control and its explanation are one block')



# An attribute value with *anything* interpolated into it, and each `${...}` inside it.
#
# The pattern here used to be `attr="${...}"` - the whole value, and nothing else. So `href="#${id}"`,
# `class="row ${cls}"` and `style="background:${c}"` were never examined at all: measured on this tree,
# **148 of 210** attribute interpolations were inspected and 62 were invisible, while the tool printed
# zero. Found by an outside review, and it is the same shape as the defect this repository already
# recorded once - a checker that reports success over the third of the surface it does not look at.
#
# The limit that *is* deliberate (element content, below) is written down. This one was not, so it
# read as complete coverage. That is the difference between a limit and a blind spot.
# `[^"]` and not `[^"\n]`: an attribute value may be written across two lines - a long `title=` with
# its text wrapped - and the line-bound version could not match one, so it read the value as absent.
# The crude scan below saw the interpolation and the careful one did not, which is how this hole was
# found: by the tool auditing itself on its first run after being widened. Bounded, so an unbalanced
# quote somewhere cannot make one match swallow the rest of the file.
ATTR_WITH_EXPR = re.compile(r'(\w[\w-]*)="([^"]{0,600}?\$\{[^"]{0,600}?)"')


def interpolations(value: str) -> list:
    """Every `${...}` in an attribute value, brace-counted so a nested object literal stays whole."""
    out, i = [], 0
    while True:
        j = value.find('${', i)
        if j < 0:
            return out
        depth, k = 1, j + 2
        while k < len(value) and depth:
            if value[k] == '{':
                depth += 1
            elif value[k] == '}':
                depth -= 1
            k += 1
        out.append(value[j + 2:k - 1])
        i = k


# What widening it uncovered is 41 expressions that are inert and cannot be shown to be inert *by
# syntax*: an anchor built by `sanitize()`, a colour from the panel's own palette, a class from a
# ternary of literals, a number. Teaching `suspect()` their names would be an allow-list of functions
# - the checklist wearing a script's clothes this repository refuses - so they are a **ledger**, like
# `cssdupes.txt` and `asyncglobals.txt`: recorded with their place, anything new is a finding, and the
# ledger should shrink, and a run that grows it says so. Two real ones were fixed before it was
# written rather than recorded in it.
LEDGER = ROOT / 'tools' / 'attrraw.txt'


def key(rel, attr: str, expr: str) -> str:
    return hashlib.sha256(f'{rel}\x00{attr}\x00{expr}'.encode('utf-8')).hexdigest()[:16]


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



# The denominator, found by a **cruder** method than the check uses - and compared by *position*
# rather than by count, because a crude count is either short or long and neither proves anything.
#
# This is the mechanism that would have caught the defect above on the day it was written, and it is
# the one thing this file learnt that generalises. The careful pass reads attribute values properly.
# This one walks the raw text and marks every `${` that has an unclosed `="` behind it on the same
# line - which is over-broad on purpose. Every position it marks must fall inside something the
# careful pass actually read; one that does not is a **finding about the tool**, printed before any
# finding about the code.
#
# A checker that prints «32 shipped scripts, 30 pages» is telling the truth about what it opened and
# nothing about what it examined - which is exactly how two thirds of this one's subject stayed
# invisible while the number on screen looked healthy.


def crude_slots(src: str) -> set:
    """Offsets of every `${` that looks like it is inside a quoted attribute value."""
    out = set()
    for m in re.finditer(r'\$\{', src):
        line_start = src.rfind('\n', 0, m.start()) + 1
        before = src[line_start:m.start()]
        q = before.rfind('="')
        if q < 0:
            continue
        if '"' not in before[q + 2:]:          # the attribute's closing quote has not gone by yet
            out.add(m.start())
    return out


def main() -> int:
    accept = '--accept' in sys.argv
    ledger = {} if accept else read_ledger()
    findings = []
    # Before the attributes themselves: whether the thing that makes an attribute safe is safe.
    findings += weak_escapers()
    seen = missed = 0
    for path in FILES:
        src = re.sub(r'^\s*//.*$', '', path.read_text(encoding='utf-8'), flags=re.M)
        crude, read = crude_slots(src), []
        for m in ATTR_WITH_EXPR.finditer(src):
            # Where each `${` this pass consumed actually starts, so the two can be compared by place.
            at = src.index(m.group(2), m.start())
            for expr in interpolations(m.group(2)):
                read.append(src.index('${' + expr, at))
                at = read[-1] + 2
        seen += len(read)
        blind = crude - set(read)
        missed += len(blind)
        for off in sorted(blind)[:3]:
            findings.append(f'{path.relative_to(ROOT)}:{src[:off].count(chr(10)) + 1}: this checker '
                            f'does not look here - a cruder scan sees an attribute interpolation the '
                            f'careful one never read')
        for m in ATTR_WITH_EXPR.finditer(src):
            attr, value = m.group(1), m.group(2)
            line = src[:m.start()].count('\n') + 1
            rel = path.relative_to(ROOT)
            for expr in interpolations(value):
                if not suspect(expr):
                    continue
                short = ' '.join(expr.split())[:60]
                if key(rel, attr, short) in ledger:
                    continue
                findings.append(f'{rel}:{line}: {attr}="${{{short}}}" is not attribute-escaped')

    pages = sorted(p for p in (ROOT / 'apps').rglob('*.html'))
    pages += sorted((ROOT / 'site').rglob('*.html'))
    for path in pages:
        findings += [f'{path.relative_to(ROOT).parent}/{f}' for f in display_override(path)]
        findings += [f'{path.relative_to(ROOT).parent}/{f}' for f in duplicate_attributes(path)]
        findings += [f'{path.relative_to(ROOT).parent}/{f}' for f in divs_are_closed(path)]
    notes_belong_to_a_control(findings)

    if accept:
        rows = ['# Derived by tools/htmlcheck.py - do not edit by hand; run it with --accept.',
                '# Attribute interpolations that are not attribute-escaped and are inert for a reason',
                '# syntax cannot see: an anchor through sanitize(), a colour from our own palette, a',
                '# ternary of literals, a number. It should shrink; growth is printed.']
        for f in findings:
            place, _, rest = f.partition(': ')
            rel, _, _line = place.rpartition(':')
            attr, _, expr = rest.partition('="${')
            rows.append(f'{key(rel, attr, expr.rsplit("}\" is not", 1)[0])}  {f}')
        _before = ledger_count(LEDGER)
        LEDGER.write_text('\n'.join(rows) + '\n', encoding='utf-8')
        print(ledger_delta(f'htmlcheck: {LEDGER.relative_to(ROOT)}', _before, ledger_count(LEDGER)))
        return 0
    # Before anything about the code: what this tool did not look at. A gap here is a defect in the
    # checker, and it goes first because a finding count printed under an unstated blind spot is the
    # number that gets quoted as evidence.
    print(f'htmlcheck: {len(FILES)} shipped scripts, {len(pages)} pages, '
          f'{seen} attribute interpolation(s) inspected'
          + (f', {missed} NOT LOOKED AT' if missed else ', none left unread'))
    for f in findings:
        print('  ' + f)
    print()
    print(f'{len(findings)} finding(s). Markup that does not do what it looks like it does.'
          if findings else
          '0 findings. Attributes are escaped, and hidden hides.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
