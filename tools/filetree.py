#!/usr/bin/env python3
"""The repository as a tree, with the number of lines beside every file.

    python3 tools/filetree.py                  # to stdout
    python3 tools/filetree.py <file>           # to a file, for reading somewhere else

Asked for to see the shape and the weight of the thing in one view. It is a tool and not a file
somebody types because a listing of 250 numbers is stale the moment it is saved, and a number typed
by hand is a number nobody can check - the two failures this repository spends its length
preventing, in the one artefact whose whole content is numbers.

**The subject is what git tracks**, from `git ls-files`: that is what the repository *is*, and it is
also the only definition that cannot drift - `dist/`, `node_modules` and every scratch file are
outside it without anything needing to list them. A file that is tracked and unreadable as text is
marked `binary` rather than given a count, because zero lines and "not text" are different facts and
one of them would be a lie.

**A line ends at a newline, and a last line without one still counts.** So this agrees with
`wc -l` everywhere except a file whose final line is unterminated, where `wc` undercounts by one:
the text is there and a reader sees it.

It said `splitlines()` first, and that was wrong in the way that matters - it also broke on the
vertical tab, the form feed, the three ASCII separators, NEL, U+2028 and U+2029, so
`tests/tools_test.py` came out as 8164
lines against the 8162 that git, `wc` and every editor report. That file carries U+2028 and U+2029
as *data*, in the case that documents this very trap in `whatsnew.py`, where the same six separators
split a release note's records in half. A count nothing else agrees with is not a count. Found by
comparing against a cruder method before publishing the number, which is the only reason it was
found at all.

Directory rows carry the subtree's file count and line total. That is one step past what was asked
for, and it is here because a tree of this size is unreadable without it - the eye needs somewhere
to land before it reaches the leaves.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def tracked() -> list:
    """Every file git tracks, as paths relative to the repository root.

    `-z` and a split on NUL rather than on newline: a filename may contain a newline, and a listing
    that breaks on one would silently drop or invent entries. Nothing here has such a name today,
    which is exactly when a reader stops noticing that the parsing is wrong.
    """
    out = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, text=True, cwd=str(ROOT))
    if out.returncode != 0:
        sys.exit(f'git ls-files failed: {out.stderr.strip()}')
    return sorted(p for p in out.stdout.split('\0') if p)


def lines_in(rel: str):
    """How many lines the file holds, or None when it is not text.

    Read as bytes and decoded here rather than with `read_text`, so the one interesting failure -
    a tracked binary - is answered rather than raised.
    """
    try:
        data = (ROOT / rel).read_bytes()
    except OSError:
        return None
    if b'\0' in data:                      # a NUL byte settles it before any decoder guesses
        return None
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return None
    if not text:
        return 0
    return text.count('\n') + (0 if text.endswith('\n') else 1)


def build(paths: list) -> dict:
    """A nested dict of the paths: {name: subtree} for folders, {name: count_or_None} for files."""
    tree = {}
    for rel in paths:
        parts = rel.split('/')
        here = tree
        for part in parts[:-1]:
            here = here.setdefault(part, {})
        here[parts[-1]] = lines_in(rel)
    return tree


def totals(node: dict) -> tuple:
    """(files, lines) for a subtree. Binaries count as files and contribute no lines."""
    files = lines = 0
    for value in node.values():
        if isinstance(value, dict):
            f, l = totals(value)
            files += f
            lines += l
        else:
            files += 1
            lines += value or 0
    return files, lines


# The tree is drawn in ASCII on purpose: this file gets pasted into a terminal, a chat window and an
# editor, and `|--` survives all three. The box-drawing characters would be prettier here and are
# the same bet the long dash lost - a reader cannot tell them apart from what a bad encoding makes
# of them until it has already happened.
def draw(node: dict, out: list, prefix: str = '') -> None:
    names = sorted(node, key=lambda n: (not isinstance(node[n], dict), n.lower()))
    for i, name in enumerate(names):
        last = i == len(names) - 1
        stem = '`-- ' if last else '|-- '
        value = node[name]
        if isinstance(value, dict):
            files, lines = totals(value)
            head = f'{prefix}{stem}{name}/'
            out.append(f'{head:<72} {files:>5} file(s)  {lines:>7} lines')
            draw(value, out, prefix + ('    ' if last else '|   '))
        else:
            head = f'{prefix}{stem}{name}'
            out.append(f'{head:<72} {"binary" if value is None else value:>21}')


def render() -> str:
    paths = tracked()
    tree = build(paths)
    files, lines = totals(tree)
    binaries = sum(1 for p in paths if lines_in(p) is None)
    commit = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'],
                            capture_output=True, text=True, cwd=str(ROOT)).stdout.strip()
    head = [
        f'zoost - every tracked file, with its number of lines. Commit {commit or "unknown"}.',
        '',
        'Derived by tools/filetree.py from `git ls-files`, so it describes the repository and not',
        'the working directory: dist/, node_modules and anything untracked are deliberately absent.',
        'A line ends at a newline, and a final line without one still counts - so these agree with',
        'wc -l except there, where it undercounts by one. Directory rows carry their subtree totals.',
        '',
        f'{files} tracked file(s), {lines} lines of text, {binaries} of them binary and uncounted.',
        '',
        '.',
    ]
    body = []
    draw(tree, body)
    return '\n'.join(head + body) + '\n'


def main() -> int:
    text = render()
    if len(sys.argv) > 1:
        dest = pathlib.Path(sys.argv[1])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding='utf-8')
        # Counted the way every other number in this file is counted, not with splitlines():
        # a tool that explains that difference and then uses the wrong side of it is a joke.
        print(f'{dest}: {text.count(chr(10)) + (0 if text.endswith(chr(10)) else 1)} line(s)')
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
