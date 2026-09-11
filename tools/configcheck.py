#!/usr/bin/env python3
"""Check that external resources and their owners stay documented."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

def check(doc: str, worker: str, wrangler: str) -> list[str]:
    required = ('GitHub Actions', 'Cloudflare Worker', 'Cloudflare KV', 'Cloudflare RUM',
                'Chrome Web Store', 'Zoho canary', 'GH_TOKEN', 'TURNSTILE_SECRET', 'STATUS')
    missing = [item for item in required if item not in doc]
    for binding in ('STATUS', 'CF_VERSION'):
        if binding not in wrangler or binding not in worker:
            missing.append(f'binding {binding}')
    if re.search(r'(?:ghp_|sk-|AIza|Bearer\\s+[A-Za-z0-9])', doc):
        missing.append('secret-like literal in operations documentation')
    return missing

def main() -> int:
    doc = (ROOT / 'docs' / 'operations.md').read_text(encoding='utf-8')
    worker = (ROOT / 'site' / '_worker.js').read_text(encoding='utf-8')
    wrangler = (ROOT / 'site' / 'wrangler.jsonc').read_text(encoding='utf-8')
    missing = check(doc, worker, wrangler)
    if '--self-test' in sys.argv:
        assert not missing
        assert any('STATUS' in item for item in check(doc.replace('STATUS', 'MISSING'), worker, wrangler))
        print('configuration self-test: green')
        return 0
    if missing:
        print('configuration: ' + '; '.join(missing))
        return 1
    print('configuration: green (external systems, owners and bindings documented)')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
