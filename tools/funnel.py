#!/usr/bin/env python3
"""Read the aggregate zoost.it conversion funnel from Cloudflare Analytics Engine.

    python3 tools/funnel.py --days 30

The read-only API token and account id come from `tools/machine.env` (or the process environment),
never from a committed file. The token needs only `Account Analytics: Read`. `--sql` prints the
query without using a credential, which also makes the measurement definition reviewable offline.

Cloudflare SQL API: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import machine  # noqa: E402

DATASET = 'zoost_funnel'


def query(days: int) -> str:
    """The one maintainer-facing definition of a funnel count.

    Analytics Engine may sample busy indexes. Weighting the value by `_sample_interval` is the
    documented way to recover a count; COUNT() would quietly understate it once sampling starts.
    """
    if not 1 <= days <= 90:
        raise ValueError('days must be between 1 and 90')
    return f"""SELECT
  blob1 AS event,
  blob2 AS page,
  blob3 AS language,
  SUM(_sample_interval * double1) AS events
FROM {DATASET}
WHERE timestamp >= NOW() - INTERVAL '{days}' DAY
GROUP BY event, page, language
ORDER BY event, page, language
FORMAT JSON"""


def read(account: str, token: str, sql: str) -> dict:
    url = f'https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql'
    req = urllib.request.Request(url, data=sql.encode(), method='POST', headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'text/plain; charset=utf-8',
        'User-Agent': 'zoost-funnel/1 (+https://zoost.it)',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:500]
        raise RuntimeError(f'Cloudflare answered HTTP {e.code}: {detail}') from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'Cloudflare could not be reached: {e.reason}') from e


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--days', type=int, default=30, choices=range(1, 91), metavar='1..90')
    ap.add_argument('--sql', action='store_true', help='print the query and do not contact Cloudflare')
    args = ap.parse_args()
    sql = query(args.days)
    if args.sql:
        print(sql)
        return 0

    account = machine.get('CLOUDFLARE_ACCOUNT_ID')
    token = machine.get('CLOUDFLARE_ANALYTICS_TOKEN')
    if not account or not token:
        print('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN in tools/machine.env. '
              'The token needs only Account Analytics: Read.', file=sys.stderr)
        return 2
    try:
        answer = read(account, token, sql)
    except (RuntimeError, json.JSONDecodeError) as e:
        print(str(e), file=sys.stderr)
        return 1

    rows = answer.get('data') if isinstance(answer, dict) else None
    if not isinstance(rows, list):
        print('Cloudflare returned no data array; the dataset may not exist until the first event.', file=sys.stderr)
        return 1
    # ASCII punctuation, like everything else a reader might copy: this printed a long dash, and
    # neither exception applies to a tool's own output.
    print(f'zoost.it funnel - last {args.days} day(s)')
    print('event\tpage\tlanguage\tcount')
    for row in rows:
        print(f"{row.get('event', '')}\t{row.get('page', '')}\t{row.get('language', '')}\t{row.get('events', 0)}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
