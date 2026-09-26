#!/usr/bin/env python3
"""Read-only inventory of literal Chrome storage keys and likely stale entries.

Dynamic keys (the graph token and provider names, for example) are reported as dynamic rather than
guessed. This is an audit aid, not a destructive cleanup: it never touches a profile or deletes a
key merely because no literal consumer was found.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALL = re.compile(r'chrome\.storage\.(local|session)\.(get|set|remove)\s*\(([^;]*?)\)', re.S)
STRING = re.compile(r"['\"]([A-Za-z][A-Za-z0-9_-]{1,80})['\"]")


def _object_keys(args: str) -> set[str]:
    """Read only first-level object properties from a storage.set argument."""
    start = args.find('{')
    if start < 0:
        return set()
    out: set[str] = set()
    depth = 0
    boundary = start + 1
    for index in range(start, len(args)):
        char = args[index]
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
        elif char == ':' and depth == 1:
            match = re.search(r"(?:['\"])?([A-Za-z][A-Za-z0-9_-]{1,80})(?:['\"])?\s*$", args[boundary:index])
            if match:
                out.add(match.group(1))
        elif char == ',' and depth == 1:
            boundary = index + 1
    return out


def inventory(root: Path = ROOT) -> dict[str, dict[str, dict[str, list[str]]]]:
    result: dict[str, dict[str, dict[str, list[str]]]] = {}
    for app in ('crm', 'analytics'):
        areas = {'local': {'read': set(), 'write': set(), 'dynamic': set()},
                 'session': {'read': set(), 'write': set(), 'dynamic': set()}}
        for source in (root / 'apps' / app).glob('*.js'):
            text = source.read_text(encoding='utf-8')
            for area, op, args in CALL.findall(text):
                if op == 'set':
                    # Only object property names are keys. Values such as `preview` and `maximized`
                    # are deliberately ignored; treating every string in the object as a key made
                    # the first version of this audit report false write-only candidates.
                    keys = _object_keys(args)
                else:
                    keys = set(STRING.findall(args))
                if keys:
                    areas[area]['read' if op == 'get' else 'write'].update(keys)
                if not keys or '[' in args or ']' in args or '${' in args:
                    areas[area]['dynamic'].add(source.name)
        result[app] = {area: {kind: sorted(values) for kind, values in kinds.items()}
                       for area, kinds in areas.items()}
    return result


def main() -> int:
    for app, areas in inventory().items():
        print(app)
        for area, values in areas.items():
            read, write = set(values['read']), set(values['write'])
            print(f'  {area}: read={sorted(read)} write={sorted(write)}')
            if values['dynamic']:
                print(f"    dynamic={values['dynamic']}")
            # These are candidates only: defaults can be supplied by another execution context.
            if read - write:
                print(f'    read-only candidates (review, do not delete): {sorted(read - write)}')
            if write - read:
                print(f'    write-only candidates (review, do not delete): {sorted(write - read)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
