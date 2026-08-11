#!/usr/bin/env python3
"""Serves the repository and accepts the PNGs tools/icons.html renders, writing them in place.

There is no SVG rasteriser here and there will not be one; the browser is the renderer. Run this and
open the URL it prints, then press Generate. The favicon is assembled after.

The port was written into this file and into `tools/icons.html`, which is two places to change and
one to forget - and a fixed port is a property of a machine, not of this project: whatever is already
listening on it here is nobody else's problem. It comes from `ZOOST_ICONS_PORT`, in the environment or
in `tools/machine.env`, and the URL is printed rather than documented so there is nothing to keep in
step.
"""
import base64, http.server, json, os, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import machine  # noqa: E402
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT  = ROOT
PORT = int(machine.get('ZOOST_ICONS_PORT', '8798'))

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def do_POST(self):
        n = int(self.headers['content-length'])
        items = json.loads(self.rfile.read(n))
        written = []
        for dest, _size, b64 in items:
            p = (ROOT / dest) if dest.startswith('ico/') else (OUT / dest)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(b64))
            written.append(f'{dest} {p.stat().st_size}B')
        body = json.dumps(written).encode()
        self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

os.chdir(ROOT)
print(f'open http://localhost:{PORT}/tools/icons.html and press Generate')
print(f'  (set ZOOST_ICONS_PORT in tools/machine.env if {PORT} is taken on this machine)')
http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()
