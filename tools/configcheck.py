#!/usr/bin/env python3
"""Validate the external-configuration inventory against its consumers."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _names(rows: object) -> dict[str, dict]:
    if not isinstance(rows, list):
        return {}
    return {str(row.get("name")): row for row in rows if isinstance(row, dict) and row.get("name")}


def _references(workflows: str) -> set[str]:
    return set(re.findall(r"secrets\.([A-Z][A-Z0-9_]*)", workflows))


def _worker_env(worker: str) -> set[str]:
    return set(re.findall(r"\benv\.([A-Z][A-Z0-9_]*)", worker))


def _wrangler_bindings(wrangler: str) -> set[str]:
    return set(re.findall(r'"binding"\s*:\s*"([A-Z][A-Z0-9_]*)"', wrangler))


def check(doc: str, worker: str, wrangler: str, workflows: str = "", manifest: dict | None = None) -> list[str]:
    """Return actionable mismatches; keep the first three arguments for existing callers."""
    missing: list[str] = []
    for item in ('GitHub Actions', 'Cloudflare Worker', 'Cloudflare KV', 'Cloudflare RUM',
                 'Chrome Web Store', 'Zoho canary', 'GH_TOKEN', 'TURNSTILE_SECRET', 'STATUS',
                 'CF_KV_TOKEN', 'CWS_SERVICE_ACCOUNT', 'REPORT_SALT', 'ASSETS', 'CF_VERSION',
                 'ZOOST_CANARY_CRM_CSRF'):
        if item not in doc:
            missing.append(f'documentation: {item}')
    if re.search(r'(?:ghp_|sk-|AIza|Bearer\s+[A-Za-z0-9])', doc):
        missing.append('secret-like literal in operations documentation')
    if manifest is None:
        for binding in ('STATUS', 'CF_VERSION'):
            if binding not in wrangler or binding not in worker:
                missing.append(f'binding {binding}')
        return missing

    if manifest.get('version') != 1:
        missing.append('configuration manifest version')
    actions = _names(manifest.get('github_actions'))
    worker_secrets = _names(manifest.get('worker_secrets'))
    bindings = _names(manifest.get('worker_bindings'))
    if set(actions) != {'CF_KV_TOKEN', 'CWS_SERVICE_ACCOUNT'}:
        missing.append('GitHub Actions inventory is incomplete or has unexpected entries')
    if set(worker_secrets) != {'GH_TOKEN', 'TURNSTILE_SECRET', 'REPORT_SALT'}:
        missing.append('Worker secret inventory is incomplete or has unexpected entries')
    if set(bindings) != {'STATUS', 'ASSETS', 'CF_VERSION'}:
        missing.append('Worker binding inventory is incomplete or has unexpected entries')

    action_refs = _references(workflows)
    for name in sorted(action_refs - set(actions)):
        missing.append(f'workflow secret not in manifest: {name}')
    for name in sorted(set(actions) - action_refs):
        missing.append(f'manifest secret not referenced by workflow: {name}')
    worker_refs = _worker_env(worker)
    declared_worker = set(worker_secrets) | set(bindings)
    for name in sorted(worker_refs - declared_worker):
        missing.append(f'Worker env binding not in manifest: {name}')
    for name in sorted(set(worker_secrets) - worker_refs):
        missing.append(f'manifest Worker secret not referenced: {name}')
    wrangler_refs = _wrangler_bindings(wrangler)
    for name in sorted(wrangler_refs - set(bindings)):
        missing.append(f'Wrangler binding not in manifest: {name}')
    for name in sorted(set(bindings) - wrangler_refs):
        missing.append(f'manifest binding not in wrangler: {name}')
    for name, row in {**actions, **worker_secrets, **bindings}.items():
        if not row.get('consumer') or not isinstance(row.get('required'), bool):
            missing.append(f'manifest entry incomplete: {name}')
    return missing


def _load() -> tuple[str, str, str, str, dict]:
    doc = (ROOT / 'docs' / 'operations.md').read_text(encoding='utf-8')
    worker = (ROOT / 'site' / '_worker.js').read_text(encoding='utf-8')
    wrangler = (ROOT / 'site' / 'wrangler.jsonc').read_text(encoding='utf-8')
    workflows = '\n'.join(p.read_text(encoding='utf-8') for p in (ROOT / '.github' / 'workflows').glob('*.yml'))
    path = ROOT / 'tools' / 'operations-manifest.json'
    try:
        manifest = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        manifest = {}
    return doc, worker, wrangler, workflows, manifest


def main() -> int:
    doc, worker, wrangler, workflows, manifest = _load()
    missing = check(doc, worker, wrangler, workflows, manifest)
    if '--self-test' in sys.argv:
        assert not missing, missing
        broken = json.loads(json.dumps(manifest))
        broken['worker_secrets'][0]['consumer'] = ''
        assert any('manifest entry incomplete' in item for item in check(doc, worker, wrangler, workflows, broken))
        wrong = json.loads(json.dumps(manifest))
        wrong['github_actions'][0]['name'] = 'WRONG_OWNER'
        assert any('inventory is incomplete' in item for item in check(doc, worker, wrangler, workflows, wrong))
        print('configuration self-test: green')
        return 0
    if missing:
        print('configuration: ' + '; '.join(missing))
        return 1
    print('configuration: green (external systems, owners and bindings derived from manifest)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
