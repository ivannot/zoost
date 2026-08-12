#!/usr/bin/env python3
"""Talking to the Chrome Web Store API: the token, and who the items are.

One implementation, four callers - `cwsscope.py`, `cwsupload.py`, `storestatus.py`, and whatever
comes next. Neither id is secret: the publisher is in every dashboard URL, the item ids are in the
listing URLs.

The two extension ids are **read out of `site/_worker.js`**, because the site genuinely uses them -
every listing link is built from `EXT_ID` - so reading them keeps one copy of a fact that has to be
right in both places. The publisher id is declared **here**, and the difference is the lesson:

It used to be read from the Worker too, and then the Worker stopped calling the Chrome Web Store API
and `const PUBLISHER` went with the code that used it - correctly, since dead code is not allowed to
sit there waiting to be someone's dependency. Every tool in this file broke at once, `store upload`
included, and nothing said so for forty minutes: these run on a schedule or at a release, so the red
lands where nobody is looking. **Reading a constant out of another file is a dependency on that file
still wanting it**, which is invisible from the file being edited - so it is only worth it while both
sides genuinely need the value. `EXT_ID` passes that test and the publisher no longer did.

The JWT is signed with the `openssl` already on the machine, so this needs nothing installed.

**Nothing here publishes.** The upload path stops at the draft; `:publish` is a decision, and a
decision is the one thing this repository does not automate.
"""
import base64
import json
import pathlib
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN_URL = 'https://oauth2.googleapis.com/token'
API = 'https://chromewebstore.googleapis.com'
READ = 'https://www.googleapis.com/auth/chromewebstore.readonly'
WRITE = 'https://www.googleapis.com/auth/chromewebstore'
_b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')


def _worker() -> str:
    return (ROOT / 'site' / '_worker.js').read_text(encoding='utf-8')


# Not a secret: it is in every Chrome Web Store dashboard URL. Declared here rather than read from
# the site, because the site has no use for it - see the note in the docstring above.
PUBLISHER = 'f3724a09-0185-4176-ab7e-3b1df03ca3b7'


def publisher() -> str:
    return PUBLISHER


def item_id(app: str) -> str:
    block = re.search(r'const EXT_ID = \{(.*?)\}', _worker(), re.S)
    ids = dict(re.findall(r"(\w+): '(\w+)'", block.group(1) if block else '')) or {}
    if app not in ids:
        raise SystemExit(f'site/_worker.js knows no extension id for "{app}" - it has {sorted(ids)}')
    return ids[app]


def token(key: dict, scope: str) -> str:
    now = int(time.time())
    head = _b64(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    claim = _b64(json.dumps({'iss': key['client_email'], 'scope': scope, 'aud': TOKEN_URL,
                             'iat': now, 'exp': now + 3600}).encode())
    body = head + b'.' + claim
    with tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False) as f:
        f.write(key['private_key'])
        pem = f.name
    try:
        sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', pem],
                             input=body, capture_output=True, check=True).stdout
    finally:
        pathlib.Path(pem).unlink(missing_ok=True)
    jwt = (body + b'.' + _b64(sig)).decode()
    data = urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                   'assertion': jwt}).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data)) as r:
        return json.load(r)['access_token']


def call(tok: str, method: str, url: str, body: bytes = None, ctype: str = None) -> dict:
    """One request, with the error body read rather than thrown away.

    A failing response explains itself in its body - the lesson this repository already learnt from
    `400 INVALID_CSRF_TOKEN`, where the status named the symptom and the body named the cause."""
    headers = {'Authorization': 'Bearer ' + tok, 'x-goog-api-version': '2'}
    if ctype:
        headers['Content-Type'] = ctype
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = (e.read() or b'')[:600].decode('utf-8', 'replace')
        raise SystemExit(f'{method} {url.split("/v2/")[-1]} -> {e.code} {e.reason}\n  {detail}')


def status(tok: str, app: str) -> dict:
    return call(tok, 'GET', f'{API}/v2/publishers/{publisher()}/items/{item_id(app)}:fetchStatus')


def key_from_env(env: str = 'CWS_SERVICE_ACCOUNT') -> dict:
    import os
    raw = os.environ.get(env)
    if not raw:
        raise SystemExit(f'{env} is not set - it holds the service account JSON key')
    return json.loads(raw)
