#!/usr/bin/env python3
"""Every progress line names what it is counting, and counts it the same way in both panels.

The defect this exists for was reported from a real org: pressing Pull in Functions put
«Downloading 179/293...» on the status line, the user moved to another tab, and the line said the
same thing - so there was no way to tell what those 293 were. The status line is **one line shared
by every tab**, which is what makes a bare count useless the moment the reader looks away from the
tab that started it: two of the three item pulls beside it already said «Downloading workflow
12/40...», and that one had been shipping without its subject since it was written.

So the rule is the class rather than the incident: **a count in a progress line is preceded by the
name of what it counts.** It also catches the reverse ordering, which reads as a different number
entirely - «Functions: 3 of 7...» during Pull all is three of seven *areas*, and every reader takes
it for three of seven functions.

The second rule is uniformity, asked for in the same breath: the two panels wrote the same count
three ways (`12/40`, `12 / 40`, `3 of 7`), and a reader who uses both products should not have to
learn each one. `n/m` and `n of m` are both allowed - they read differently and each has its place -
but `n / m` is neither, so it is refused.

What this cannot do, in its own words rather than left to be discovered:

- It knows a call is a progress line by its `'busy'` kind, so a count announced through some other
  path is invisible to it. The crude denominator below is what makes that visible: it counts every
  `'busy'` in the raw file and reports any the careful pass did not read.
- It knows a subject by exclusion - a literal word that is not a bare progress verb, or an
  interpolation, which names something at run time. `${fail} Downloading ${n}/${total}` would
  satisfy it and should not. It is a net for the defect that happened, not a proof of good prose.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from jstext import strip_js                                    # noqa: E402  (same directory)

APPS = ('crm', 'analytics')

# A count: two interpolations with a separator between them. `\sof\s` rather than `of` so that
# «Reading the SQL of ${n} queries» is not read as a count of something called «the SQL».
COUNT = re.compile(r'\$\{[^{}]+\}[ ]*(?:/|\sof\s)[ ]*\$\{[^{}]+\}')
SPACED = re.compile(r'\$\{[^{}]+\}[ ]+/[ ]*\$\{[^{}]+\}|\$\{[^{}]+\}[ ]*/[ ]+\$\{[^{}]+\}')
WORD = re.compile(r"[A-Za-z][A-Za-z']+")

# A verb alone says nothing about what is being counted, which is the whole defect. Nor do the
# articles and prepositions that join it to a subject that is not there.
NOT_A_SUBJECT = {
    'downloading', 'reading', 'pulling', 'writing', 'retrying', 'saving', 'loading', 'exporting',
    'rebuilding', 'refreshing', 'checking', 'uploading', 'fetching', 'building', 'opening',
    'the', 'a', 'an', 'of', 'and', 'for', 'in', 'to', 'all', 'list', 'still',
}


def _holes_removed(text: str) -> str:
    """The literal halves of a template, with every `${...}` taken out, braces balanced."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith('${', i):
            depth, i = 1, i + 2
            while i < n and depth:
                if text[i] == '{':
                    depth += 1
                elif text[i] == '}':
                    depth -= 1
                i += 1
            out.append(' ')
            continue
        out.append(text[i])
        i += 1
    return ''.join(out)


def _busy_calls(src: str) -> tuple[list[tuple[int, str]], list[int]]:
    """Every call whose kind is `'busy'`, as (offset of its `(`, argument text) - and the positions
    a cruder scan can see that this one could not read. The crude half is the point: a careful
    reader that quietly skips a call is indistinguishable from a file with nothing in it."""
    read, missed = [], []
    for kind in re.finditer(r"""(?<![\w$])'busy'""", src):
        end = src.rfind(',', 0, kind.start())
        if end < 0:
            missed.append(kind.start())
            continue
        depth, i = 0, end - 1
        while i >= 0:
            c = src[i]
            if c in ')]}':
                depth += 1
            elif c in '([{':
                if depth == 0 and c == '(':
                    break
                depth -= 1
            i -= 1
        if i < 0 or not src[i + 1:end].strip():
            missed.append(kind.start())
            continue
        read.append((i, src[i + 1:end]))
    return read, missed


def _line(src: str, offset: int) -> int:
    return src.count('\n', 0, offset) + 1


def scan(root: Path = ROOT) -> tuple[list[str], int]:
    findings: list[str] = []
    inspected = 0
    for app in APPS:
        for path in sorted((root / 'apps' / app).glob('*.js')):
            raw = path.read_text(encoding='utf-8')
            src = strip_js(raw)
            calls, missed = _busy_calls(src)
            rel = path.relative_to(root)
            for offset in missed:
                findings.append(f'{rel}:{_line(src, offset)}: this check could not read a busy '
                                'status call it can see - widen it before believing its answer')
            for offset, arg in calls:
                inspected += 1
                count = COUNT.search(arg)
                if not count:
                    continue
                before = _holes_removed(arg[:count.start()])
                named = '${' in arg[:count.start()] or any(
                    w.lower() not in NOT_A_SUBJECT for w in WORD.findall(before))
                shown = arg.strip()[:120]
                if not named:
                    findings.append(
                        f'{rel}:{_line(src, offset)}: a count with nothing before it that says what '
                        f'is counted - the status line is shared by every tab: {shown}')
                if SPACED.search(arg):
                    findings.append(
                        f'{rel}:{_line(src, offset)}: a count written «n / m» - the other panel '
                        f'writes «n/m», and a reader who uses both should not learn two: {shown}')
    return findings, inspected


def self_test() -> None:
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for app in APPS:
            (root / 'apps' / app).mkdir(parents=True)
        good = root / 'apps' / 'crm' / 'good.js'
        good.write_text(
            "op.say(`Downloading function ${i + 1}/${n}\\u2026`, 'busy');\n"
            "op.say(`${e.name} - transition ${a} of ${b}...`, 'busy');\n"
            "setStatus(`Reading the SQL of ${n} queries...`, 'busy');\n"
            "// a comment saying 'busy' and ${a}/${b} is not a call\n", encoding='utf-8')
        findings, inspected = scan(root)
        assert findings == [], findings
        assert inspected == 3, inspected

        bad = root / 'apps' / 'analytics' / 'bad.js'
        bad.write_text("op.say(`Downloading ${i + 1}/${pending.length}\\u2026`, 'busy');\n"
                       "op.say(`Pulling ${m.stage} ${m.done} / ${m.total}...`, 'busy');\n",
                       encoding='utf-8')
        findings, _ = scan(root)
        assert len(findings) == 2, findings
        assert 'nothing before it' in findings[0] and 'bad.js:1' in findings[0], findings
        assert 'n / m' in findings[1] and 'bad.js:2' in findings[1], findings


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        self_test()
        print('progress: self-test green')
    else:
        found, seen = scan()
        crude = sum(path.read_text(encoding='utf-8').count("'busy'")
                    for app in APPS for path in (ROOT / 'apps' / app).glob('*.js'))
        print(f'progresscheck: {seen} progress lines read, of {crude} the raw text can see')
        if found:
            print('\n'.join(found))
            raise SystemExit(1)
        print('0 findings. Every count says what it counts, and both panels write it the same way.')
