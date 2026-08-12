#!/usr/bin/env python3
"""Ask the Chrome Web Store what it is serving, and write it into the site as a file.

    CWS_SERVICE_ACCOUNT="$(cat key.json)" python3 tools/storestatus.py

**This exists to get a publishing credential out of a web-facing runtime.** The Worker used to ask
Google directly, which meant the service-account key sat in Cloudflare as a Secret that code running
on every request could read. And that key can publish: `tools/cwsscope.py` mints a token for the full
`chromewebstore` scope from it and the API answers. Read-only was a property of what the Worker
*asked for*, never of the credential, and Google links one service account per publisher with no
narrower grant on offer - so least privilege was not available where it was needed, and the only
remaining move was to stop holding the key there at all.

So the question is asked here, on a schedule, and the answer is committed as an ordinary file the
Worker serves. The key stays where it already had to be - the GitHub Actions secret that
`store-upload.yml` needs to stage a draft - instead of being in two places.

What it costs is freshness: the badge was at most ten minutes behind and is now as far behind as the
schedule. That was worth paying because the moment anyone cares is the hour after a submission, and
this also runs at the end of the release chain, when that is exactly what has just happened.

**A failure never overwrites a good reading.** If Google cannot be asked this exits non-zero, the
workflow goes red, and the previous file stands.

The reading is committed **only when the numbers move**, which is a handful of times a month rather
than a heartbeat every half hour - a history where every commit means «the Store changed» is worth
more than one that proves the cron ran. The cost is that a workflow which quietly stopped is not
visible from the file itself, so `asOf` is carried in it and shown on /emergency: a reader sees when
the Store was last actually asked and can weigh it, which is this project's answer everywhere else -
expose the number, do not interpret it.
"""
import argparse
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import cws  # noqa: E402

APPS = ('crm', 'analytics')
OUT = ROOT / 'site' / 'store-status.json'
IS_VERSION = re.compile(r'^\d+(\.\d+){1,3}$')   # the same guard the Worker used, moved with the job


def shape(d: dict) -> dict | None:
    """One revision pair out of a fetchStatus response, or None if it carries neither.

    A field that is not a version is dropped rather than published: a change at Google's end may cost
    us the number, and must never invent one. This is the check that made the old scrape survivable
    and it moves here unchanged, because the promise it protects did not move.
    """
    def rev(x):
        if not x or not x.get('state'):
            return None
        ch = (x.get('distributionChannels') or [{}])[0] or {}
        v = str(ch.get('crxVersion') or '').strip()
        pct = ch.get('deployPercentage')
        return {
            'state': x['state'],
            'version': v if IS_VERSION.match(v) else None,
            'deployPercentage': pct if isinstance(pct, (int, float)) else None,
        }

    published, submitted = rev(d.get('publishedItemRevisionStatus')), rev(d.get('submittedItemRevisionStatus'))
    if not published and not submitted:
        return None
    return {'published': published, 'submitted': submitted, 'takenDown': bool(d.get('takenDown'))}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out', default=str(OUT), help='where to write it (default: site/store-status.json)')
    args = ap.parse_args()

    key = cws.key_from_env()
    # Read-only is still what this asks for. It is not what makes the key safe - nothing here can do
    # that - but asking for more than the job needs would be gratuitous.
    tok = cws.token(key, 'https://www.googleapis.com/auth/chromewebstore.readonly')

    out = {'asOf': datetime.datetime.now(datetime.timezone.utc)
                           .replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
           'cws': 'ok'}
    for app in APPS:
        out[app] = shape(cws.status(tok, app))

    path = pathlib.Path(args.out)
    # Sorted keys and a trailing newline, because this file is committed: an unstable key order would
    # produce a diff on every run and the history would stop meaning «the Store changed».
    text = json.dumps(out, indent=2, sort_keys=True) + '\n'
    before = path.read_text(encoding='utf-8') if path.exists() else ''

    def versions(t):
        try:
            d = json.loads(t)
        except Exception:                                  # noqa: BLE001 - a first run has no file
            return None
        return {a: d.get(a) for a in APPS}

    path.write_text(text, encoding='utf-8')
    moved = versions(before) != versions(text)
    for app in APPS:
        b = out[app] or {}
        p, s = b.get('published') or {}, b.get('submitted') or {}
        print(f'  {app:10} store {p.get("version") or "unknown"}'
              + (f' · submitted {s.get("version")} ({s.get("state")})' if s.get('version') else ''))
    # The caller commits only when something actually changed, and this is what says so. `asOf` moves
    # on every run by design, so it is deliberately not part of the comparison - otherwise the file
    # would be committed every half hour and every commit would say nothing.
    print('changed' if moved else 'unchanged')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
