#!/usr/bin/env python3
"""Read-only inventory of literal Chrome storage keys and likely stale entries.

Dynamic keys (the graph token and provider names, for example) are reported as dynamic rather than
guessed. This is an audit aid, not a destructive cleanup: it never touches a profile or deletes a
key merely because no literal consumer was found.
"""
from __future__ import annotations

import re
import argparse
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'tools' / 'storage-manifest.json'
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


def check_manifest(root: Path = ROOT, manifest_path: Path = MANIFEST) -> list[str]:
    """Compare literal keys with the reviewed storage contract.

    The audit intentionally does not guess dynamic keys.  This check covers the opposite edge:
    every literal key written or read by a shipped script must have an owner and lifecycle in the
    manifest, and a removed key must leave the manifest in the same change.  It is a contract check,
    not a migration or a request to delete anything from a user's profile.
    """
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    findings: list[str] = []
    actual = inventory(root)
    for app in ('crm', 'analytics'):
        declared_app = manifest.get('apps', {}).get(app, {})
        for area in ('local', 'session'):
            declared = declared_app.get(area, {}).get('keys', {})
            if not isinstance(declared, dict):
                findings.append(f'{app}.{area}: manifest keys must be an object')
                declared = {}
            actual_keys = set(actual[app][area]['read']) | set(actual[app][area]['write'])
            declared_keys = set(declared)
            for key in sorted(actual_keys - declared_keys):
                findings.append(f'{app}.{area}: literal key {key!r} is not in storage manifest')
            for key in sorted(declared_keys - actual_keys):
                findings.append(f'{app}.{area}: manifest key {key!r} has no literal consumer')
            for key, record in declared.items():
                if not isinstance(record, dict):
                    findings.append(f'{app}.{area}.{key}: manifest record must be an object')
                    continue
                for field in ('owner', 'lifecycle'):
                    if not str(record.get(field, '')).strip():
                        findings.append(f'{app}.{area}.{key}: missing {field}')
    return findings


def self_test() -> None:
    """Prove that both an unlisted key and a missing owner turn the check red."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for app in ('crm', 'analytics'):
            app_dir = root / 'apps' / app
            app_dir.mkdir(parents=True)
            (app_dir / 'one.js').write_text(
                "chrome.storage.local.get('known'); chrome.storage.local.set({known: true});",
                encoding='utf-8')
        manifest = root / 'manifest.json'
        manifest.write_text(json.dumps({'apps': {
            'crm': {'local': {'keys': {'known': {'owner': 'one.js', 'lifecycle': 'persistent'}}}, 'session': {'keys': {}}},
            'analytics': {'local': {'keys': {'known': {'owner': 'one.js', 'lifecycle': 'persistent'}}}, 'session': {'keys': {}}},
        }}), encoding='utf-8')
        assert check_manifest(root, manifest) == []
        (root / 'apps' / 'crm' / 'one.js').write_text(
            "chrome.storage.local.get('known'); chrome.storage.local.set({known: true, newKey: 1});",
            encoding='utf-8')
        assert any('newKey' in item for item in check_manifest(root, manifest))
        manifest.write_text(json.dumps({'apps': {
            'crm': {'local': {'keys': {'known': {'owner': '', 'lifecycle': 'persistent'}}}, 'session': {'keys': {}}},
            'analytics': {'local': {'keys': {'known': {'owner': 'one.js', 'lifecycle': 'persistent'}}}, 'session': {'keys': {}}},
        }}), encoding='utf-8')
        assert any('missing owner' in item for item in check_manifest(root, manifest))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='check literal keys against the manifest')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print('storage audit self-test: green')
        return 0
    if args.check:
        findings = check_manifest()
        if findings:
            print('\n'.join(findings))
            return 1
        print('storage manifest: green')
        return 0
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
