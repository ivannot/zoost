#!/usr/bin/env python3
"""tools/machine.env, read from Python: `import machine; machine.load()`

There is one file in this repository for values that belong to a machine and not to the project - a
mount point, a browser in an odd place, a port already taken - and it is `tools/machine.env`, which
is git-ignored. It was readable from shell only, so the Python tools each had their own arrangement:
`CHROME` had to be exported into the session, and a port was written into two files. One file for
these values was the point; two ways of reading it and one of them missing is most of the way back.

**The environment wins over the file, always.** A value passed on purpose - by a test, by a one-off
run, by CI - must not be replaced by whatever this machine usually does. The shell side does the same
thing, and got it backwards first: sourcing the file overrode `ZOOST_TEST_DIR` and two cases went
green while copying to the real folder.

The format is what a shell can source: `KEY='value'`, `#` comments, blank lines. It is parsed here
rather than executed, because a Python tool has no business running someone's shell file.
"""
import os
import pathlib
import re

ENV = pathlib.Path(__file__).resolve().parent / 'machine.env'
LINE = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$")


def values() -> dict:
    """What the file holds, whether or not it has been applied."""
    out = {}
    if not ENV.exists():
        return out
    for line in ENV.read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = LINE.match(line)
        if not m:
            continue
        v = m.group(2)
        if len(v) > 1 and v[0] == v[-1] and v[0] in '\'"':
            v = v[1:-1]
        out[m.group(1)] = v
    return out


def load() -> dict:
    """Apply them to os.environ, without overriding what is already set. Returns what it applied."""
    applied = {}
    for k, v in values().items():
        if not os.environ.get(k):
            os.environ[k] = v
            applied[k] = v
    return applied


def get(key: str, default: str = '') -> str:
    """One value, environment first. For a tool that wants a single key and not a whole load()."""
    return os.environ.get(key) or values().get(key) or default


if __name__ == '__main__':
    found = values()
    print(f'{ENV} - {len(found)} value(s)' if found else
          f'{ENV} does not exist: this machine has nothing of its own recorded')
    for k in sorted(found):
        print(f'  {k}')          # the names, never the values: this prints in shared terminals
