#!/usr/bin/env python3
"""What a `--accept` did to a ledger, said in the direction it moved.

Five tools here keep a ledger - `cssdupes.txt`, `asyncglobals.txt`, `notenglish.txt`,
`attrraw.txt` - and every one of them, along with three places in `CLAUDE.md`, states that **the
ledger may only shrink**. Eleven statements of one rule, and nothing behind any of them: `--accept`
records whatever is there and prints the new total, so a ledger that grew and one that shrank print
the same shape of line.

Measured from git rather than argued. `notenglish.txt` has grown on **every** commit that touched
it - 33, 38, 39, 41, 42, 43. `asyncglobals.txt` went from 52 entries to 79 in one step.
`cssdupes.txt`, the one the rule was written for, fell 86 -> 35 and then grew to 38. The rule is
false about three of the four, and the repository's own thesis says why that was predictable: every
rule with a checker behind it has held, and every rule living only as prose has been broken.

**The prose was also wrong to be absolute**, which is the more useful half. A ledger grows for two
reasons that look identical in the file: somebody accepted new debt, or **the tool started seeing
more**. The 52 -> 79 jump was the second - `asynccheck` learnt to read inside an IIFE and found two
content bridges it had been scoring as empty - and that growth is not debt at all. Refusing it
would have refused the fix.

So the direction is *printed* instead of forbidden: what was recorded, what went, what arrived, and
the one sentence that says which of the two reasons the reader has to be able to name. A number
nobody compares against anything is not evidence, which is the rule this repository already applies
to every other count it prints.
"""


def delta(name: str, before: int, after: int) -> str:
    """One line for the end of an `--accept` run. `before` is the count already in the file."""
    if after == before:
        return f'{name}: {after} entry/entries recorded, unchanged.'
    if after < before:
        return f'{name}: {after} recorded, {before - after} fewer than before - the ledger shrank.'
    return (f'{name}: {after} recorded, {after - before} MORE than before. A ledger grows for two '
            f'reasons that look the same in the file - new debt was accepted, or the check started '
            f'seeing more. Say which in the commit message.')


def count(path) -> int:
    """Entries in a ledger file: lines that are not blank and not a comment. 0 if it is not there."""
    try:
        with open(path, encoding='utf-8') as fh:
            return sum(1 for line in fh if line.strip() and not line.lstrip().startswith('#'))
    except OSError:
        return 0


def keep_comments(path, own) -> list:
    """Comment lines already in the ledger that the tool did not write itself.

    A ledger is regenerated whole by `--accept`: the tool writes its own header and the entries, and
    anything else in the file is gone. `tools/asyncglobals.txt` carried **nineteen** hand-written
    lines - which of the 79 entries are cache invalidations, why the options pages are recorded
    rather than exempted, what the tool cannot see - and every one of them was one `--accept` away
    from being deleted without a word. Found by deleting them: this function exists because the
    author of it did exactly that while changing the header sentence one line above.

    The file invites explanation - «being here means somebody read it and decided it is safe» is an
    invitation to say *why* - and then throws it away. Kept now, in the order it was found, after
    whatever header the tool generates this time.
    """
    own = {line.rstrip('\n') for line in own}
    out = []
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                line = line.rstrip('\n')
                if line.lstrip().startswith('#') and line not in own:
                    out.append(line)
    except OSError:
        pass
    return out
