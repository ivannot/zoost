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

So the question is asked here, on a schedule, and the answer is put in Workers KV for the Worker to
read. The key stays where it already had to be - the GitHub Actions secret that `store-upload.yml`
needs to stage a draft - instead of being in two places.

**It went to KV rather than into a committed file, and the reason is a defect the file caused.**
Anything under `site/` is a build watch path, so committing the reading redeployed the whole site
every time Google moved a number - and `siteUpdated` in the footer comes from that deploy's own
timestamp. The footer would have announced «site updated» because a version elsewhere changed, which
is the same defect this project already fixed once for `lastChanged('site')`. KV takes the reading
out of the deploy path entirely.

It also fixes what the file could not: `asOf` is refreshed on **every** run instead of only when the
numbers move, so a workflow that quietly stopped shows up as a date that stopped advancing. The page
prints it rather than judging it - a threshold here would turn a cron that ran late into «unknown».

**A failure never overwrites a good reading.** If Google cannot be asked this exits non-zero, the
workflow goes red without writing, and what is in KV stands.

What it costs is freshness: the badge was at most ten minutes behind and is now as far behind as the
schedule. That was worth paying because the moment anyone cares is the hour after a submission, and
this also runs at the end of the release chain, when that is exactly what has just happened.
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
    ap.add_argument('--out', default='-', help='where to write it; - is stdout (the default)')
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

    # Sorted keys so two readings of the same state are the same bytes. Nothing diffs this any more,
    # but a payload that reorders itself makes any future comparison useless for no gain.
    text = json.dumps(out, indent=2, sort_keys=True) + '\n'
    if args.out == '-':
        sys.stdout.write(text)
    else:
        pathlib.Path(args.out).write_text(text, encoding='utf-8')
        for app in APPS:
            b = out[app] or {}
            pub, sub_ = b.get('published') or {}, b.get('submitted') or {}
            print(f'  {app:10} store {pub.get("version") or "unknown"}'
                  + (f' · submitted {sub_.get("version")} ({sub_.get("state")})' if sub_.get('version') else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
