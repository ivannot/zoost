#!/usr/bin/env python3
"""Check that every shipped JavaScript file has a real browser entry point.

This is intentionally a narrow gate: it does not try to prove that a helper is called, only that a
file is reachable from an extension HTML page or its manifest. Dead-code candidates remain a
separate, human-reviewed report from ``tools/deadcode.py``.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _manifest_scripts(value: object) -> set[str]:
    found: set[str] = set()
    if isinstance(value, str) and value.endswith('.js') and '/' not in value:
        found.add(value)
    elif isinstance(value, list):
        for item in value:
            found.update(_manifest_scripts(item))
    elif isinstance(value, dict):
        for item in value.values():
            found.update(_manifest_scripts(item))
    return found


def scan(root: Path = ROOT) -> list[str]:
    findings: list[str] = []
    for app in ('crm', 'analytics'):
        directory = root / 'apps' / app
        shipped = {path.name for path in directory.glob('*.js')}
        referenced: set[str] = set()
        for page in directory.glob('*.html'):
            referenced.update(re.findall(r'(?:src|href)="([^"/]+\.js)"', page.read_text(encoding='utf-8')))
        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
        referenced.update(_manifest_scripts(manifest))
        for name in sorted(shipped - referenced):
            findings.append(f'{app}: shipped script has no HTML or manifest entrypoint: {name}')
    return findings


def self_test() -> None:
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        app = root / 'apps' / 'crm'
        app.mkdir(parents=True)
        (app / 'manifest.json').write_text('{"background":{"service_worker":"background.js"}}', encoding='utf-8')
        (app / 'background.js').write_text('', encoding='utf-8')
        (app / 'orphan.js').write_text('', encoding='utf-8')
        (root / 'apps' / 'analytics').mkdir(parents=True)
        (root / 'apps' / 'analytics' / 'manifest.json').write_text('{}', encoding='utf-8')
        assert scan(root) == ['crm: shipped script has no HTML or manifest entrypoint: orphan.js']


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        self_test()
        print('entrypoint: self-test green')
    else:
        findings = scan()
        if findings:
            print('\n'.join(findings))
            raise SystemExit(1)
        total = sum(len(list((ROOT / 'apps' / app).glob('*.js'))) for app in ('crm', 'analytics'))
        print(f'entrypoint: green ({total} shipped scripts reachable from HTML or manifests)')
