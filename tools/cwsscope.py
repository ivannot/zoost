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
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cws  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[0])
    key = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
    print(f'service account: {key["client_email"]}')
    try:
        tok = cws.token(key, cws.WRITE)
    except Exception as e:
        print(f'refused at the token: {e}')
        print('-> the full scope is NOT granted to this key')
        return 1
    body = cws.status(tok, 'analytics')       # a read, and the only call this tool makes
    print('read back:', json.dumps(body)[:160])
    print('-> the full `chromewebstore` scope IS granted: this key can publish. '
          'Every copy of it is a publishing credential.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
