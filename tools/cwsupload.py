#!/usr/bin/env python3
"""Upload a built package to the Chrome Web Store as a draft - and stop there.

    CWS_SERVICE_ACCOUNT="$(cat key.json)" python3 tools/cwsupload.py analytics dist/zoost-…-store.zip

It closes the one gap `RELEASES.md` admits in writing: *«uploading it to the Store is a manual step,
so nothing here cryptographically proves the file Google received is that one»*. Run from CI, the
thing that uploads is the thing that built and signed it, and the sentence stops being needed.

**It never publishes**, and that is not an omission. `:publish` is a decision, and the boundary this
project draws is that every derivation and every verification is automated while every decision stays
with the author. The package lands as a draft; the listing fields and the screenshots cannot be set
through the API at all, so somebody has to open the dashboard anyway - which is the right moment to
press Submit.

Two things it does that a `curl` one-liner would not: it reads back the item's status afterwards and
prints what Google now holds, and it refuses to run when the item already has something in review,
because uploading over a submission in progress is the one state nobody here has measured.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cws  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[0])
    app, zip_path = sys.argv[1], pathlib.Path(sys.argv[2])
    if not zip_path.is_file():
        sys.exit(f'{zip_path} does not exist - download the asset from the Release, never build here')
    key = cws.key_from_env()
    tok = cws.token(key, cws.WRITE)
    item = cws.item_id(app)

    before = cws.status(tok, app)
    pending = (before.get('submittedItemRevisionStatus') or {}).get('state')
    if pending == 'PENDING_REVIEW':
        sys.exit(f'{app}: Google already has a revision in review. Wait for it, or cancel that '
                 f'submission in the dashboard first - uploading over one is a state nobody here '
                 f'has measured.')

    print(f'{app}: uploading {zip_path.name} ({zip_path.stat().st_size} bytes) to item {item}')
    out = cws.call(tok, 'POST',
                   f'{cws.API}/upload/v2/publishers/{cws.publisher()}/items/{item}:upload',
                   body=zip_path.read_bytes(), ctype='application/zip')
    state = out.get('uploadState') or out.get('state') or '?'
    print(f'  upload state: {state}')
    for err in out.get('itemError') or []:
        print(f'  {err.get("error_code", "")}: {err.get("error_detail", "")}')
    if state in ('FAILURE', 'NOT_FOUND'):
        return 1

    after = cws.status(tok, app)
    sub = after.get('submittedItemRevisionStatus') or {}
    pub = after.get('publishedItemRevisionStatus') or {}
    print(f'  published: {pub.get("version", "?")} ({pub.get("state", "?")})')
    print(f'  draft now: {sub.get("version", "?")} ({sub.get("state", "?")})')
    print('  Nothing was published. Open the dashboard, set whatever the listing needs, press Submit.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
