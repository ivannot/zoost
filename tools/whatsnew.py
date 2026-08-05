#!/usr/bin/env python3
"""
whatsnew.py — the commits that changed one app, since that app's last released tag.

The Chrome Web Store asks for a "What's new" on every submission and the GitHub Release wants a
body, and both were being written from memory. Memory is the wrong source: this repository ships two
products from one history, so «what changed» for Zoho CRM is not the last N commits — it is the
commits that touched `apps/crm/`, and a fortnight of work on the site or on the other product sits
between them.

    python3 tools/whatsnew.py crm              # since the newest crm-v* tag
    python3 tools/whatsnew.py crm --since crm-v1.9.0
    python3 tools/whatsnew.py analytics --files    # with the files each commit touched

**It gathers; it does not write.** A commit subject is addressed to whoever reads this repository —
"One folder per kind, one index.json in each, and no underscores" is a fine release note and "Two
dimensions nothing was measuring" is not — so the output is raw material for a person, and the tool
says so rather than pretending the two registers are one. What it does guarantee is that nothing is
missing, which is the part memory gets wrong.

Two things it points out because they are what a release note is judged against:

  * the version the manifest moved through, read from the manifest at each end of the range rather
    than from the tag name, so a bump nobody tagged is still visible;
  * commits that touched the app **and** an outward surface (the site, the store copy, README), since
    those are the ones whose wording already exists somewhere and should not be invented twice.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTWARD = ('site/', 'store/', 'README.md')


def git(*a: str) -> str:
    out = subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True)
    if out.returncode != 0:
        raise SystemExit(f'git {" ".join(a)}: {out.stderr.decode().strip()}')
    return out.stdout.decode()


def semver(tag: str):
    """Sort key for `<app>-vX.Y.Z`. Text order puts 1.10.0 before 1.9.0; the ledger will reach 1.10
    long before anyone looks, so this is numeric — the same trap already fixed in the Worker."""
    m = re.search(r'-v(\d+)\.(\d+)\.(\d+)$', tag)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def last_tag(app: str):
    tags = [t for t in git('tag', '--list', f'{app}-v*').split() if semver(t) != (0, 0, 0)]
    return max(tags, key=semver) if tags else None


def version_at(ref: str, app: str):
    try:
        return json.loads(git('show', f'{ref}:apps/{app}/manifest.json'))['version']
    except Exception:                                     # noqa: BLE001 — absence is a fact, not a crash
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('app', help='crm or analytics')
    ap.add_argument('--since', help='a ref to start from (default: that app\'s newest tag)')
    ap.add_argument('--files', action='store_true', help='list the files each commit touched')
    args = ap.parse_args()

    app_dir = ROOT / 'apps' / args.app
    if not app_dir.is_dir():
        raise SystemExit(f'no such app: apps/{args.app}')

    since = args.since or last_tag(args.app)
    if not since:
        raise SystemExit(f'{args.app} has never been tagged — pass --since <ref>')

    rng = f'{since}..HEAD'
    was, now = version_at(since, args.app), version_at('HEAD', args.app)
    print(f'{args.app}: {rng}')
    print(f'  manifest {was or "?"} → {now or "?"}'
          + ('' if was != now else '   ← the version has not moved; bump it before tagging'))

    # A tab, and split on '\n' rather than splitlines(). The obvious separator here is \x1e, RS,
    # and it silently destroys the output: Python's splitlines() treats \x1e, \x1c, \x1d, \x85,
    # \u2028 and \u2029 as line boundaries too, so every record broke in half and the tool reported
    # that nothing had changed — the worst possible answer from a release-notes tool, and a clean
    # instance of the pattern already in CLAUDE.md: a value crossing a boundary and being read
    # differently on the other side.
    sep = '\t'
    log = git('log', '--reverse', f'--format=%h{sep}%s', rng, '--', f'apps/{args.app}/')
    rows = [l.split(sep, 1) for l in log.split('\n') if sep in l]
    if not rows:
        print(f'\n  no commit has touched apps/{args.app}/ since {since}.')
        return 0

    print(f'\n{len(rows)} commit(s) touched apps/{args.app}/:\n')
    for sha, subject in rows:
        touched = git('show', '--name-only', '--format=', sha).split()
        outward = sorted({p.split('/')[0] + '/' if '/' in p else p
                          for p in touched if p.startswith(OUTWARD)})
        mark = '  · also ' + ', '.join(outward) if outward else ''
        print(f'  {sha}  {subject}{mark}')
        if args.files:
            for p in sorted(p for p in touched if p.startswith(f'apps/{args.app}/')):
                print(f'            {p}')

    other = [l for l in git('log', '--format=%h', rng).split('\n') if l]
    print(f'\n  ({len(other)} commit(s) in the range in all; the rest did not touch this app.)')
    print('\n  These are commit subjects, written for this repository. A "What\'s new" is written for\n'
          '  someone who has the extension installed and has never read a commit — take the facts,\n'
          '  not the sentences. What this guarantees is that none of them is missing.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
