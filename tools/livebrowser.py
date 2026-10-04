#!/usr/bin/env python3
"""tools/livebrowser.py - the one place that talks to a browser the author has logged in.

    python3 tools/livebrowser.py --check                 # is it there, and what is it
    python3 tools/livebrowser.py --tabs                  # what is open, by title and address
    python3 tools/livebrowser.py --targets               # everything, extensions included
    python3 tools/livebrowser.py --panel crm             # what the Zoost window is showing
    python3 tools/livebrowser.py --press crm connections # one named control, from the list below

**Why this exists as a file rather than as a command typed each time.** Everything else in this
repository drives a browser it launched itself, against invented data: `tools/shots.py` and
`tools/probe.py` start their own Chrome, load a fixture through `tools/fsshim.js`, and never touch a
real Zoho session. That is what makes them safe to run unattended, and it is also their ceiling -
rate limits, role refusals, a data centre's own shapes and a session that can expire are things no
fixture reproduces, which is the whole reason `tools/handcheck.py` exists and asks a person.

This reaches a browser **the author has opened and logged in**. That is a different kind of tool and
it gets its own file so the difference is visible, so the permission that allows it can name one
script instead of a whole interpreter, and so the boundary below lives somewhere a reader will find
it rather than in a chat nobody can grep.

**The boundary, and it is the point of the file.** Zoost is read-only towards Zoho; a browser is
not. The session this attaches to can delete a record, change a field and send mail to somebody's
customer, because that is what the user sitting in front of it could do. So:

  - It reads, and it presses controls **of Zoost's own window**, which is ours and writes nothing to
    Zoho.
  - It does not touch Zoho's own interface at all: no clicking in it, no submitting, no confirming.
  - Anything it is asked to do is said before it is done, so what happens on the author's screen is
    checkable while it happens rather than afterwards.

**And there is no way to run arbitrary code through it.** The obvious shape for a driver is
`--eval <javascript>`, and it is deliberately absent: a tool that takes any expression and runs it
in a live, logged-in browser is a remote-execution surface whatever its docstring promises - the
boundary above would be a sentence and the capability would be everything. What is here instead is a
**vocabulary**: `READS` and `CONTROLS` below, each entry named, each a fixed expression, each
reviewable on its own. «Read the status line» is something a person can check; «run this string» is
not. A new operation is added here, by name, and its addition is a diff in a repository rather than
a phrase in a chat.

**How it finds the browser.** Chrome binds its debugging port to loopback and recent versions ignore
any request to bind elsewhere, so from inside WSL there is a forward on the Windows side and the
address of that forward is a property of one machine - it even changes when WSL restarts. It lives
in `tools/machine.env` as `ZOOST_LIVE_CDP`, like every other machine value here, and without it this
tool says so and does nothing.

**What it is not.** Not part of `tests/run.sh`, not part of `tools/prepare.sh`, not reachable from a
release. Nothing automatic may drive somebody's live CRM session: it runs when a person asks for it,
in front of a person who can see what it is doing.
"""
import argparse
import base64
import json
import os
import pathlib
import socket
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import machine  # noqa: E402

FALLBACK = 'http://127.0.0.1:9222'

# Which Zoost window each product opens. The address is the extension's own page, and the extension
# id differs per profile for an unpacked copy - so the page name is what identifies it, not the id.
PANEL = {'crm': 'workbench.html', 'analytics': 'workbench.html'}
TITLE = {'crm': 'Zoho CRM', 'analytics': 'Zoho Analytics'}

# ---------------------------------------------------------------------------------------------
# The vocabulary. Everything this tool can ask a page is in these two tables and nowhere else.
#
# A read answers a question about what is on screen. A control is one element of **Zoost's own
# window** that may be pressed. Nothing here addresses a page of Zoho's: the two are different
# origins and different responsibilities, and the separation is the boundary made mechanical rather
# than promised.
# The stored working-folder handle, read out of the panel's own IndexedDB the way the panel reads
# it - `zoost`, store `kv`, key `rootDir`, which both products use because each extension is its own
# origin.
#
# **It opens nothing that is not already there, and that is not fastidiousness.** The first version
# called `indexedDB.open('zoost', 1)` straight away, which *creates* the database when it is absent -
# and with no `onupgradeneeded` of its own it creates one with no object stores at all. Handed over
# as a console line to paste, it answered «One of the specified object stores was not found», which
# is the sound of a probe reporting on the damage it had just done: on the wrong origin it makes an
# empty `zoost`, and on the right one a database in that state breaks the panel, because
# `db.transaction('kv')` throws and two of the four callers do not guard it.
#
# So it asks `databases()` first and opens nothing when the name is not listed, and it says which
# stores exist rather than failing on their absence. It also reports `location.href` on **every**
# path including the failure - the first version put it in the answer and dropped it in the catch,
# so the one field that says where a reading came from went missing exactly when it was needed.
HANDLE_TEMPLATE = (
    "(async () => {{ const where = location.href; try {{"
    " const names = (await indexedDB.databases()).map((d) => d.name);"
    " if (!names.includes('zoost')) return [where, 'no zoost database on this origin', names];"
    " const db = await new Promise((res, rej) => {{ const q = indexedDB.open('zoost');"
    " q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }});"
    " if (!db.objectStoreNames.contains('kv'))"
    " return [where, 'the zoost database has no kv store', [...db.objectStoreNames]];"
    " const h = await new Promise((res, rej) => {{"
    " const t = db.transaction('kv').objectStore('kv').get('rootDir');"
    " t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }});"
    " return [where, {answer}];"
    " }} catch (e) {{ return [where, 'unreadable: ' + ((e && e.message) || e)]; }} }})()"
)

READS = {
    'status': "(document.getElementById('stxt')||document.getElementById('statustext')||{}).textContent||''",
    'workspace': "(document.getElementById('ws')||{}).value||''",
    'folder': "(document.getElementById('wsroot')||{}).textContent||''",
    'context': "(document.getElementById('who')||{}).textContent||''",
    'bound': "(document.getElementById('bound')||{}).textContent||''",
    'behind': "(document.getElementById('behind')||{}).textContent||''",
    'missing': "(document.getElementById('missing')||{}).textContent||''",
    'rows': "document.querySelectorAll('#tree .f').length",
    'mode': "(document.querySelector('.mseg.on,#modebar button.on')||{}).textContent||''",
    # **What Chrome says about the working folder, rather than what the panel says about it.**
    # Added the day a question about the folder prompt was answered by asking him to paste a line
    # into a console - with this tool open and a browser attached. The table *is* the extension
    # point of this design, and skipping it to hand the work to a person is the one use of it that
    # defeats the point. `handle` is what the browser has stored; `permission` is what it will
    # answer for it without being asked twice.
    #
    # `requestPermission()` is deliberately absent and must stay absent. It is not a read: it can
    # raise a browser dialog, it needs a gesture this tool does not have, and it *changes* the
    # grant. A table whose entries have effects is not a vocabulary of questions any more.
    # **Where the time goes when an item is opened**, which is the one question about this product
    # that a headless harness cannot answer: the state it was reported in - a real org, a real
    # File System Access handle, every other browser window closed - is a browser's, not a fixture's.
    # The panel records the stages with their elapsed time (`openTrace`), and this reads the last few
    # back. A reading, like every other entry here: it takes nothing and changes nothing.
    'opens': "(window.__zoostOpenTrace || []).slice(-14).join(' | ') || 'no open recorded yet'",
    # **Where Chrome's permission dialog went.** It opened behind the Zoost window on a real machine,
    # and nothing in a page can see that prompt - but while `requestPermission()` is pending the panel
    # samples whether this document still has the focus, and that is the one signal that would let the
    # sentence say «it opened in another window» rather than «look behind this one». Read back here so
    # the next report comes with a measurement instead of a guess.
    'grant': ("(window.__zoostGrantFocus || []).slice(-3).join(' | ')"
              " || 'no permission request recorded yet'"),
    # Which build is actually loaded in front of the reader - asked before believing what `opens`
    # says, because «nothing recorded» reads identically whether the panel has not been used or the
    # window is still running the copy from before the instrument existed. An unpacked extension
    # keeps running its old code until it is reloaded, and that is not observable from here.
    'build': ("chrome.runtime.getManifest().version + ' | openTrace:' + (typeof openTrace)"
              " + ' | pvload:' + (document.getElementById('pvload') ? 'yes' : 'no')"),
    'handle': HANDLE_TEMPLATE.format(answer="h ? h.name : 'no handle stored'"),
    'permission': HANDLE_TEMPLATE.format(
        answer="h ? await h.queryPermission({ mode: 'readwrite' }) : 'no handle stored'"),
}
CONTROLS = {
    # The tab strip: which list the panel is showing.
    'functions': "modebar:Functions", 'modules': "modebar:Modules",
    'workflows': "modebar:Workflows", 'schedules': "modebar:Schedules",
    'blueprints': "modebar:Blueprints", 'actions': "modebar:Actions",
    'connections': "modebar:Connections",
    # The pulls. `pull` is the whole org, `pulltab` is the list the panel is standing on.
    'pull': "id:pull", 'pulltab': "id:pulltab", 'refresh': "id:refresh",
}


def endpoint() -> str:
    """Where the live browser answers. The value belongs to a machine, so it is read from one."""
    return (machine.get('ZOOST_LIVE_CDP') or FALLBACK).rstrip('/')


def ask(path: str, timeout: float = 5.0):
    """One read from the debugging endpoint, with the failure said rather than raised bare.

    A refused connection and a timeout mean different things here and the difference is worth the
    two lines: refused is «nothing is listening», which is a browser that was never started with the
    port open; a timeout is «something is dropping this», which on Windows is the firewall or a
    forward that is not there. Telling them apart is most of the debugging of this setup.
    """
    url = f'{endpoint()}{path}'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.URLError as e:
        reason = getattr(e, 'reason', e)
        hint = ('nothing is listening there - Chrome was not started with --remote-debugging-port, '
                'or the forward is missing'
                if 'refused' in str(reason).lower() else
                'the connection is being dropped rather than refused - on Windows that is usually '
                'the firewall, or a portproxy that is not in place'
                if 'timed out' in str(reason).lower() else str(reason))
        sys.exit(f'livebrowser: {url} did not answer: {hint}')


# ---------------------------------------------------------------------------------------------
# A websocket client in sixty lines, because the alternative was a dependency.
#
# The DevTools protocol reads over HTTP and *speaks* over a websocket: `/json/list` says what is
# open and nothing more. This project ships with no dependencies and its tools follow the same rule
# - `tools/capture.mjs` speaks the protocol in node for exactly this reason - so the frames are
# written here rather than installed. The client half only: one connection, text frames, no
# fragmentation, no extensions. That is all the protocol needs and every line of it is readable.
def _ws_connect(url: str, timeout: float):
    u = urllib.parse.urlparse(url)
    sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
    sock.settimeout(timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    path = u.path + (('?' + u.query) if u.query else '')
    sock.sendall((f'GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n'
                  'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                  f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
    head = b''
    while b'\r\n\r\n' not in head:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError('the browser closed the connection during the handshake')
        head += chunk
    if b' 101 ' not in head.split(b'\r\n')[0]:
        raise ConnectionError('the browser refused the websocket: '
                              + head.split(b'\r\n')[0].decode('latin-1'))
    return sock, bytearray(head.split(b'\r\n\r\n', 1)[1])


def _ws_send(sock, text: str):
    """One masked text frame. A client must mask, a server must not - that is the whole asymmetry."""
    data = text.encode()
    mask = os.urandom(4)
    n = len(data)
    header = b'\x81'
    if n < 126:
        header += struct.pack('!B', 0x80 | n)
    elif n < (1 << 16):
        header += struct.pack('!BH', 0x80 | 126, n)
    else:
        header += struct.pack('!BQ', 0x80 | 127, n)
    sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def _ws_recv(sock, buf: bytearray) -> str:
    """One frame, reassembled from however many reads the socket felt like giving."""
    def take(n):
        while len(buf) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError('the browser closed the connection')
            buf.extend(chunk)
        out = bytes(buf[:n])
        del buf[:n]
        return out

    b0, b1 = take(2)
    opcode, length = b0 & 0x0F, b1 & 0x7F
    if length == 126:
        length = struct.unpack('!H', take(2))[0]
    elif length == 127:
        length = struct.unpack('!Q', take(8))[0]
    payload = take(length)
    if opcode == 0x8:
        raise ConnectionError('the browser closed the connection')
    return payload.decode('utf-8', 'replace')


def _panel_target(app: str):
    """The Zoost window of one product, among everything the browser has open."""
    want = TITLE[app]
    for t in ask('/json/list'):
        if (t.get('type') == 'page' and PANEL[app] in (t.get('url') or '')
                and want in (t.get('title') or '') and t.get('webSocketDebuggerUrl')):
            return t
    sys.exit(f'livebrowser: the Zoost window for {want} is not open - click its toolbar icon')


def _run(app: str, expression: str, timeout: float = 20.0):
    """One expression from the tables above, in that product's Zoost window.

    Private on purpose: `READS` and `CONTROLS` are the only callers, so the set of things that can
    reach a page is the set written down at the top of this file.
    """
    target = _panel_target(app)
    sock, buf = _ws_connect(target['webSocketDebuggerUrl'], timeout)
    try:
        _ws_send(sock, json.dumps({
            'id': 1, 'method': 'Runtime.evaluate',
            'params': {'expression': expression, 'awaitPromise': True, 'returnByValue': True},
        }))
        while True:                      # events arrive unasked; ours is the one carrying the id
            msg = json.loads(_ws_recv(sock, buf))
            if msg.get('id') != 1:
                continue
            if 'error' in msg:
                sys.exit(f"livebrowser: the browser refused it: {msg['error'].get('message')}")
            res = msg.get('result', {})
            if res.get('exceptionDetails'):
                d = res['exceptionDetails']
                sys.exit('livebrowser: the page threw: '
                         + (d.get('exception', {}).get('description') or d.get('text', '?')))
            return res.get('result', {}).get('value')
    finally:
        try:
            sock.close()
        except OSError:
            pass


def press(app: str, name: str):
    """One named control of Zoost's own window.

    A tab is found by its word rather than by an id because the CRM builds that row at run time; a
    pull is an id because it is in the markup. Either way the *name* is from `CONTROLS` and the
    expression is written here - there is no path from a name the caller invents to a page.
    """
    spec = CONTROLS[name]
    kind, what = spec.split(':', 1)
    if kind == 'id':
        expr = (f"(() => {{ const b = document.getElementById({what!r});"
                " if (!b) return 'absent';"
                " if (b.disabled) return 'disabled: ' + (b.title || 'no reason given');"
                " b.click(); return 'pressed'; }})()")
    else:
        expr = (f"(() => {{ const b = [...document.querySelectorAll('.mseg,#modebar button')]"
                f".find((e) => (e.textContent || '').trim() === {what!r});"
                " if (!b) return 'absent';"
                " if (b.disabled) return 'disabled: ' + (b.title || 'no reason given');"
                " b.click(); return 'pressed'; }})()")
    return _run(app, expr)


def read(app: str, name: str):
    return _run(app, READS[name])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--check', action='store_true', help='is a browser there, and which')
    ap.add_argument('--tabs', action='store_true', help='what is open in it')
    ap.add_argument('--targets', action='store_true',
                    help='everything the browser exposes, extensions included')
    ap.add_argument('--panel', metavar='APP', choices=sorted(PANEL),
                    help="what that product's Zoost window is showing")
    ap.add_argument('--read', nargs=2, metavar=('APP', 'WHAT'),
                    help='one reading: ' + ', '.join(sorted(READS)))
    ap.add_argument('--press', nargs=2, metavar=('APP', 'CONTROL'),
                    help='one control of the Zoost window: ' + ', '.join(sorted(CONTROLS)))
    args = ap.parse_args()

    if args.press:
        app, name = args.press
        if app not in PANEL or name not in CONTROLS:
            sys.exit(f'livebrowser: {app}/{name} is not in the vocabulary - see --help')
        print(f'  {name}: {press(app, name)}')
        return 0

    if args.read:
        app, name = args.read
        if app not in PANEL or name not in READS:
            sys.exit(f'livebrowser: {app}/{name} is not in the vocabulary - see --help')
        print(f'  {name}: {read(app, name)}')
        return 0

    if args.panel:
        for name in ('folder', 'workspace', 'mode', 'context', 'bound', 'behind', 'missing',
                     'rows', 'status'):
            value = read(args.panel, name)
            if value not in ('', None):
                print(f'  {name:<10} {value}')
        return 0

    if not (args.check or args.tabs or args.targets):
        print(__doc__.strip().splitlines()[0])
        print(f'  endpoint: {endpoint()}'
              + ('' if machine.get('ZOOST_LIVE_CDP') else '   (the fallback - ZOOST_LIVE_CDP is not set)'))
        return 0

    if args.check:
        d = ask('/json/version')
        print(f"  browser: {d.get('Browser', '?')}")
        print(f"  protocol: {d.get('Protocol-Version', '?')}")
        print(f"  reached at {endpoint()}")

    if args.tabs:
        pages = [t for t in ask('/json/list') if t.get('type') == 'page']
        print(f'  {len(pages)} page(s) open:')
        for t in pages:
            # The address is printed whole: this is the author's own screen, and a truncated URL is
            # the thing that makes a session hard to talk about.
            print(f"    - {t.get('title') or '(no title)'}")
            print(f"      {t.get('url', '')}")

    if args.targets:
        # Pages *and* the rest: an extension shows up as a service worker or a background page, and
        # «is Zoost loaded in this profile» is a question about those rather than about tabs.
        all_t = ask('/json/list')
        print(f'  {len(all_t)} target(s):')
        for t in all_t:
            print(f"    {t.get('type', '?'):<18} {(t.get('title') or '')[:60]}")
            print(f"    {'':<18} {t.get('url', '')[:110]}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
