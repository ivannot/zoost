#!/usr/bin/env python3
"""notescheck.py - the working notes measured against the room they have left.

CLAUDE.md reached **280,013 characters against a limit of 150,000**, so nearly half of it was not
being read and nobody could say which half. That is the failure this repository spends its length
preventing, happening to the file that describes the preventing - and the detail that matters is not
that it crossed the limit, it is that **it went on to nearly double it**. Nothing measured, so there
was no signal at any point: it was reported by Claude Code itself, on the first session opened on
another machine, months of rules later.

So the number is printed on every run, next to the other checkers, whether or not anything is wrong.
A threshold that only speaks when it is breached tells you nothing about the direction you are
travelling in, and this file grows by about a thousand characters every time it is touched.

**The budget is two thirds of the limit, and the margin is the whole point.** The remedy for a full
file is not a one-line fix: a topic has to be lifted into `docs/`, given a row in the index that says
when to open it, and left readable in both places. That is an hour's work with judgement in it, so
the gate has to fire while there is room to do it calmly. Failing *at* the limit would fire it at the
moment content had already been dropped, which is what the previous check did - it asserted `< 150_000`
under the name `test_it_is_under_the_limit_with_room`, and the room was zero.

The 150,000 figure is what the harness reports, not something measured here; it is treated as the
ceiling and the budget sits well under it, so a lower real limit is still covered.

`docs/*.md` is measured and **not** judged. Those files are read on demand rather than loaded into
every session, so there is no limit to breach - only the cost of a long read, which is the author's
to weigh. A threshold there would be invented, and this project does not invent numbers to grade
work by.

    python3 tools/notescheck.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIMIT = 150_000                 # where CLAUDE.md stops being read, as reported by the harness
BUDGET = LIMIT * 2 // 3         # where we stop, so that splitting it is a decision and not a rescue


def main() -> int:
    findings = []
    main_md = ROOT / 'CLAUDE.md'
    n = len(main_md.read_text(encoding='utf-8'))
    notes = sorted((ROOT / 'docs').glob('*.md'))
    beside = sum(len(f.read_text(encoding='utf-8')) for f in notes)

    if n > BUDGET:
        findings.append(f'CLAUDE.md is {n:,} characters against a budget of {BUDGET:,}. Lift a topic '
                        f'into docs/ and give it a row in the index that says when to open it. The '
                        f'budget is two thirds of the {LIMIT:,} at which the file stops being read, '
                        f'so there is room to do this properly - it is not the failure yet.')

    for f in notes:
        if not f.read_text(encoding='utf-8').strip():
            findings.append(f'docs/{f.name} is empty - a note nobody can read is worse than no note, '
                            f'because the index promises it')

    for f in findings:
        print('  ' + f)
    print(f'\n{len(findings)} finding(s). CLAUDE.md {n:,} of {BUDGET:,} ({n * 100 // BUDGET}%), '
          f'{max(0, BUDGET - n):,} to spare; {len(notes)} note(s) beside it, {beside:,} chars read '
          f'on demand.')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main())
