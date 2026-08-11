#!/usr/bin/env python3
"""Does this service account key actually get the write scope? — python3 tools/cwsscope.py <key.json>

The badge mints a token for `chromewebstore.readonly` and the repository described that as a
credential which «can read our items' status and do nothing else to them». That is not established:
Google adds a service account to a publisher to «manage items owned by your publisher account», one
per publisher, and the scope is chosen at token time - so the narrow scope may be a property of what
we ask for and nothing more.

This asks. It mints a token for the **full** `chromewebstore` scope and makes one **read** call with
it. Nothing is uploaded, nothing is published, nothing is cancelled: the only question is whether the
wider token is issued and accepted.

    granted  -> the key can write. Treat every copy of it as a publishing credential.
    refused  -> the grant is scope-limited after all, and the API upload needs a wider one.

No dependencies: the JWT is signed with the openssl already on the machine.
"""
import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

TOKEN_URL = 'https://oauth2.googleapis.com/token'
SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
PUBLISHER = 'f3724a09-0185-4176-ab7e-3b1df03ca3b7'
ITEM = 'gmelnigbgklfjgceldicakkomhgplgge'          # Zoost Analytics - read only, never written here
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')


def token(key: dict, now: int) -> str:
    head = b64(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    claim = b64(json.dumps({'iss': key['client_email'], 'scope': SCOPE, 'aud': TOKEN_URL,
                            'iat': now, 'exp': now + 3600}).encode())
    body = head + b'.' + claim
    with tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False) as f:
        f.write(key['private_key'])
        pem = f.name
    sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', pem],
                         input=body, capture_output=True, check=True).stdout
    pathlib.Path(pem).unlink()
    jwt = (body + b'.' + b64(sig)).decode()
    data = urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                   'assertion': jwt}).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data)) as r:
        return json.load(r)['access_token']


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[0])
    key = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
    print(f'service account: {key["client_email"]}')
    import time
    try:
        tok = token(key, int(time.time()))
    except Exception as e:
        print(f'refused at the token: {e}')
        print('-> the full scope is NOT granted to this key')
        return 1
    url = f'https://chromewebstore.googleapis.com/v2/publishers/{PUBLISHER}/items/{ITEM}:fetchStatus'
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + tok})
    try:
        with urllib.request.urlopen(req) as r:
            body = json.load(r)
    except Exception as e:
        print(f'token issued, call refused: {e}')
        print('-> the key holds the wider scope but the API declined it; read the error above')
        return 1
    print('read back:', json.dumps(body)[:160])
    print('-> the full `chromewebstore` scope IS granted: this key can publish. '
          'Every copy of it is a publishing credential.')
    return 0


if __name__ == '__main__':
    import urllib.parse
    sys.exit(main())
